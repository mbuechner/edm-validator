import {SaxesParser} from './vendor/saxes-6.0.0/saxes.mjs';

const XML = 'http://www.w3.org/XML/1998/namespace';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

function reference(value) {
    const match = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#([\s\S]*))?$/.exec(value);
    if (!match || (match[1] !== undefined && !/^[A-Za-z][A-Za-z0-9+.-]*$/.test(match[1]))) {
        throw new Error('Ungültige xml:base-IRI.');
    }
    return {scheme: match[1], authority: match[2], path: match[3], query: match[4], fragment: match[5]};
}

/** RFC 3986 section 5.2.4; percent escapes and all Unicode code units remain untouched. */
function removeDotSegments(path) {
    let input = path;
    let output = '';
    while (input) {
        if (input.startsWith('../')) input = input.slice(3);
        else if (input.startsWith('./')) input = input.slice(2);
        else if (input.startsWith('/./')) input = input.slice(2);
        else if (input === '/.') input = '/';
        else if (input.startsWith('/../') || input === '/..') {
            input = input === '/..' ? '/' : input.slice(3);
            output = output.slice(0, Math.max(0, output.lastIndexOf('/')));
        } else if (input === '.' || input === '..') input = '';
        else {
            const next = input.indexOf('/', input.startsWith('/') ? 1 : 0);
            const end = next < 0 ? input.length : next;
            output += input.slice(0, end);
            input = input.slice(end);
        }
    }
    return output;
}

/** RFC 3986 section 5.2, without URL host/Unicode/default-port normalization of RDF IRIs. */
export function resolveXmlBase(value, parent) {
    const target = reference(value);
    if (target.scheme !== undefined) return value;
    const base = reference(parent || '');
    if (!base.scheme) throw new Error('Relatives xml:base benötigt eine absolute Dokument- oder übergeordnete Basis-IRI.');
    let authority;
    let path;
    let query;
    if (target.authority !== undefined) {
        authority = target.authority;
        path = removeDotSegments(target.path);
        query = target.query;
    } else {
        authority = base.authority;
        if (!target.path) {
            path = base.path;
            query = target.query === undefined ? base.query : target.query;
        } else {
            const merged = target.path.startsWith('/') ? target.path
                : base.authority !== undefined && !base.path ? '/' + target.path
                    : base.path.slice(0, base.path.lastIndexOf('/') + 1) + target.path;
            path = removeDotSegments(merged);
            query = target.query;
        }
    }
    return base.scheme + ':' + (authority === undefined ? '' : '//' + authority) + path
        + (query === undefined ? '' : '?' + query) + (target.fragment === undefined ? '' : '#' + target.fragment);
}

const escapedAttribute = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/</g, '&lt;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');

/**
 * Work around Oxigraph 0.5.13 treating xml:base as absolute-only. SAX validates XML
 * Upstream: https://github.com/oxigraph/oxigraph/blob/v0.5.13/lib/oxrdfxml/src/parser.rs#L997
 * and supplies decoded attribute values and exact source positions. Only relative
 * xml:base attribute spans are replaced; every other source character survives.
 * Descendants of rdf:parseType="Literal" are opaque lexical XML and never changed.
 */
export function resolveRdfXmlBases(xml, documentBase = '') {
    if (!xml.includes('xml:base')) return xml;
    const parser = new SaxesParser({xmlns: true});
    const stack = [{base: documentBase, literal: false}];
    const edits = [];
    let baseSpan = null;
    parser.on('opentagstart', () => { baseSpan = null; });
    parser.on('attribute', attribute => {
        if (attribute.name !== 'xml:base') return;
        const end = parser.position - 1;
        const quote = xml[end];
        if (quote !== '"' && quote !== "'") throw new Error('xml:base muss einen in Anführungszeichen eingeschlossenen Wert haben.');
        const start = xml.lastIndexOf(quote, end - 1) + 1;
        baseSpan = {start, end};
    });
    parser.on('doctype', () => { throw new Error('DOCTYPE ist beim Auflösen von xml:base nicht erlaubt.'); });
    parser.on('opentag', tag => {
        const parent = stack[stack.length - 1];
        let base = parent.base;
        if (!parent.literal) {
            const attribute = Object.values(tag.attributes).find(item => item.uri === XML && item.local === 'base');
            if (attribute) {
                base = resolveXmlBase(attribute.value, parent.base);
                if (base !== attribute.value) edits.push({...baseSpan, value: escapedAttribute(base)});
            }
        }
        const literal = parent.literal || Object.values(tag.attributes)
            .some(attribute => attribute.uri === RDF && attribute.local === 'parseType' && attribute.value === 'Literal');
        stack.push({base, literal});
    });
    parser.on('closetag', () => { stack.pop(); });
    parser.write(xml).close();
    if (!edits.length) return xml;
    const parts = [];
    let previous = 0;
    for (const edit of edits) {
        parts.push(xml.slice(previous, edit.start), edit.value);
        previous = edit.end;
    }
    parts.push(xml.slice(previous));
    return parts.join('');
}
