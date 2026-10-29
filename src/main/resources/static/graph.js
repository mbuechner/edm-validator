/* RDF explorer: the renderer is loaded on demand; document values stay text, never HTML. */
(function () {
    'use strict';

    const LIBRARY_URL = './vendor/3d-force-graph-1.80.0.min.js';
    const NODE_COLORS = window.RdfGraphNodes.COLORS;
    const panel = document.getElementById('graphPanel');
    if (!panel) return;
    const element = id => document.getElementById(id);
    let graph = null;
    let nodeFactory = null;
    let state = null;
    let libraryPromise = null;
    let revision = 0;
    let selectedId = null;
    let hoveredId = null;
    let highlightedNodes = new Set();
    let highlightedLinks = new Set();
    let overviewPending = false;
    let initialOverviewComplete = false;
    let currentDataReady = false;
    let createdNodes = new WeakSet();
    let resizeFrame = null;
    let expanded = false;
    let returnFocus = null;
    let previousOverflow = '';
    let inertElements = [];
    let fullscreenRevision = 0;

    const endpoint = value => typeof value === 'object' && value ? value.id : value;
    const shorten = (value, length = 58) => value.length > length ? value.slice(0, length - 1) + '…' : value;
    const nodeName = node => node.displayLabel || node.label || node.id;
    const isTypeLink = link => link.predicateUri === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
        || (!link.predicateUri && link.predicate === 'rdf:type');
    const isLiteralLink = link => !!(state && state.nodeMap.get(endpoint(link.target))?.nodeType === 'Literal');

    function shortId(id) {
        if (id.startsWith('literal:')) return shorten(id.slice(8));
        return shorten(id.split(/[/#]/).filter(Boolean).pop() || id);
    }

    function literalLabel(node) {
        if (typeof node.label === 'string') return node.label || '(leer)';
        // Older responses used the lexical value as an ID; current IDs encode identity.
        return node.id.replace(/^literal:/, '') || '(leer)';
    }

    function nodeCategory(node) {
        return window.RdfGraphNodes.category(node);
    }

    function nodeColor(node) {
        return (selectedId || hoveredId) && !highlightedNodes.has(node.id)
            ? NODE_COLORS.muted : NODE_COLORS[nodeCategory(node)];
    }

    function linkColor(link) {
        if ((selectedId || hoveredId) && !highlightedLinks.has(link.key)) return '#727579';
        if (isTypeLink(link)) return '#383838';
        if (selectedId || hoveredId) return '#81002d';
        return '#727579';
    }

    function linkWidth(link) {
        if (highlightedLinks.has(link.key)) return 2.4;
        return isTypeLink(link) ? 1.7 : isLiteralLink(link) ? 0.55 : 1.25;
    }

    function nodeDescription(node) {
        return node.isClass ? 'RDF-Klasse' : node.nodeType === 'Literal' ? 'Literalwert'
            : node.nodeType === 'BlankNode' ? 'Unbenannte Ressource' : 'Ressource';
    }

    function nodeTooltip(node) {
        return tooltip(nodeName(node) + '\n' + nodeDescription(node)
            + (node.classes.length ? '\nKlassen: ' + node.classes.join(', ') : '')
            + '\nVerbindungen: ' + node.degree + (node.nodeType === 'Literal' ? '' : '\n' + node.id));
    }

    function predicateName(link) {
        const uri = link.predicateUri || '';
        const prefixes = {
            'http://www.w3.org/1999/02/22-rdf-syntax-ns#': 'rdf',
            'http://www.w3.org/2000/01/rdf-schema#': 'rdfs',
            'http://www.europeana.eu/schemas/edm/': 'edm',
            'http://purl.org/dc/elements/1.1/': 'dc',
            'http://purl.org/dc/terms/': 'dcterms',
            'http://www.w3.org/2004/02/skos/core#': 'skos',
            'http://www.openarchives.org/ore/terms/': 'ore'
        };
        const namespace = Object.keys(prefixes).find(prefix => uri.startsWith(prefix));
        return namespace ? prefixes[namespace] + ':' + uri.slice(namespace.length) : link.predicate || uri || 'Beziehung';
    }

    function linkTooltip(link) {
        const source = state && state.nodeMap.get(endpoint(link.source));
        const target = state && state.nodeMap.get(endpoint(link.target));
        const label = predicateName(link) + (link.predicateUri ? '\n' + link.predicateUri : '');
        return tooltip(source && target ? nodeName(source) + ' → ' + nodeName(target) + '\n' + label : label);
    }

    function tooltip(text) {
        const content = document.createElement('div');
        content.className = 'graph-tooltip';
        content.textContent = text;
        return content;
    }

    function loadLibrary() {
        if (typeof window.ForceGraph3D === 'function') return Promise.resolve(window.ForceGraph3D);
        if (!libraryPromise) {
            libraryPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = LIBRARY_URL;
                script.async = true;
                const timeout = window.setTimeout(fail, 30000);
                function finish() {
                    window.clearTimeout(timeout);
                    script.onload = null;
                    script.onerror = null;
                }
                function fail() {
                    finish();
                    script.remove();
                    reject(new Error('Die 3D-Ansicht konnte nicht geladen werden.'));
                }
                script.onload = () => {
                    if (typeof window.ForceGraph3D !== 'function') return fail();
                    finish();
                    resolve(window.ForceGraph3D);
                };
                script.onerror = fail;
                document.head.append(script);
            }).catch(error => {
                libraryPromise = null;
                throw error;
            });
        }
        return libraryPromise;
    }

    /** Own copies prevent the force engine's endpoint/position mutations from changing API results. */
    function prepare(nodes, links) {
        const nodeMap = new Map(nodes.map(node => [node.id, {
            ...node, displayLabel: node.nodeType === 'Literal' ? literalLabel(node) : (node.label || shortId(node.id)),
            classes: Array.isArray(node.classes) ? [...node.classes] : [], degree: 0, isClass: false
        }]));
        const incoming = new Map([...nodeMap.keys()].map(id => [id, []]));
        const outgoing = new Map([...nodeMap.keys()].map(id => [id, []]));
        const edges = [];
        links.forEach((link, index) => {
            const source = endpoint(link.source);
            const target = endpoint(link.target);
            if (!nodeMap.has(source) || !nodeMap.has(target)) return;
            const edge = { ...link, source, target, key: index };
            edges.push(edge);
            outgoing.get(source).push(edge);
            incoming.get(target).push(edge);
            nodeMap.get(source).degree++;
            nodeMap.get(target).degree++;
            if (isTypeLink(edge) && nodeMap.get(target).nodeType !== 'Literal') nodeMap.get(target).isClass = true;
        });
        // Human-readable labels already present in the RDF are more useful than opaque resource IDs.
        for (const node of nodeMap.values()) {
            if (node.nodeType === 'Literal') continue;
            const labelEdge = outgoing.get(node.id).find(link => {
                const target = nodeMap.get(endpoint(link.target));
                return target.nodeType === 'Literal' && /(?:[/#]|^)(?:prefLabel|title|label|name)$/i.test(link.predicateUri || link.predicate || '');
            });
            if (labelEdge) node.displayLabel = literalLabel(nodeMap.get(endpoint(labelEdge.target)));
        }
        const prepared = [...nodeMap.values()];
        // A deterministic initial constellation makes the opening camera fit useful before physics settles.
        prepared.forEach((node, index) => {
            node.searchText = (nodeName(node) + ' ' + (node.nodeType === 'Literal' ? '' : node.id)
                + ' ' + node.classes.join(' ')).toLowerCase();
            const angle = index * 2.399963;
            const radius = 28 + Math.sqrt(index + 1) * 11;
            node.x = Math.cos(angle) * radius;
            node.y = Math.sin(angle) * radius;
            node.z = ((index % 7) - 3) * 18;
        });
        return { nodes: prepared, links: edges, nodeMap, incoming, outgoing, visibleNodes: prepared, visibleLinks: edges };
    }

    function updateHighlight() {
        highlightedNodes = new Set();
        highlightedLinks = new Set();
        const id = hoveredId || selectedId;
        if (state && id) {
            highlightedNodes.add(id);
            state.visibleLinks.forEach(link => {
                if (endpoint(link.source) === id || endpoint(link.target) === id) {
                    highlightedNodes.add(endpoint(link.source));
                    highlightedNodes.add(endpoint(link.target));
                    highlightedLinks.add(link.key);
                }
            });
        }
        if (nodeFactory && state) state.nodes.forEach(node => nodeFactory.update(node, nodeColor(node)));
        if (graph) graph.linkColor(linkColor).linkWidth(linkWidth).linkDirectionalArrowColor(linkColor);
        updateLabelPositions();
    }

    function clearInspector() {
        element('graphNodeTitle').textContent = 'Knotendetails';
        element('graphNodeType').textContent = '';
        element('graphContext').textContent = 'Knoten im Graph oder über die Suche auswählen.';
        element('graphNodeClasses').replaceChildren();
        element('graphIncomingCount').textContent = '–';
        element('graphOutgoingCount').textContent = '–';
        element('graphConnections').textContent = '';
        element('clearGraphFocusBtn').classList.add('d-none');
    }

    function renderInspector(node) {
        const incoming = state.incoming.get(node.id) || [];
        const outgoing = state.outgoing.get(node.id) || [];
        element('graphNodeTitle').textContent = nodeName(node);
        element('graphNodeType').textContent = nodeDescription(node);
        element('graphContext').textContent = node.nodeType === 'Literal' ? '' : node.id;
        element('graphIncomingCount').textContent = incoming.length;
        element('graphOutgoingCount').textContent = outgoing.length;
        element('graphNodeClasses').replaceChildren(...node.classes.map(value => {
            const badge = document.createElement('span');
            badge.className = 'badge text-bg-light border';
            badge.textContent = value;
            return badge;
        }));
        const connections = element('graphConnections');
        connections.replaceChildren();
        const orderedConnections = [...outgoing, ...incoming].sort((a, b) =>
            Number(isLiteralLink(a)) - Number(isLiteralLink(b)) || Number(isTypeLink(b)) - Number(isTypeLink(a)));
        orderedConnections.slice(0, 24).forEach(link => {
            const isOutgoing = endpoint(link.source) === node.id;
            const target = state.nodeMap.get(endpoint(isOutgoing ? link.target : link.source));
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'graph-connection btn btn-light border text-start w-100';
            button.title = target.nodeType === 'Literal' ? nodeName(target) : target.id;
            const relation = document.createElement('span');
            relation.className = 'graph-connection-predicate';
            relation.textContent = (isOutgoing ? '→ ' : '← ') + predicateName(link);
            const label = document.createElement('span');
            label.className = 'graph-connection-target';
            label.textContent = shorten(nodeName(target), 85);
            button.append(relation, label);
            button.addEventListener('click', () => selectFromControl(target));
            connections.append(button);
        });
        if (!connections.children.length) connections.textContent = 'Keine Verbindungen vorhanden.';
        if (incoming.length + outgoing.length > 24) {
            const more = document.createElement('p');
            more.className = 'small text-body-secondary mt-2';
            more.textContent = '24 von ' + (incoming.length + outgoing.length) + ' Verbindungen angezeigt.';
            connections.append(more);
        }
        element('clearGraphFocusBtn').classList.remove('d-none');
    }

    function selectNode(node) {
        if (!state || !state.visibleNodes.some(visible => visible.id === node.id)) return;
        selectedId = node.id;
        hoveredId = null;
        cancelOverview();
        renderInspector(node);
        updateHighlight();
        renderLabels();
        // Selection changes emphasis and details only; the camera stays under the user's control.
    }

    function selectFromControl(node) {
        selectNode(node);
        element('graphNodeTitle').focus({ preventScroll: true });
    }

    function clearFocus() {
        selectedId = null;
        hoveredId = null;
        clearInspector();
        updateHighlight();
        renderLabels();
    }

    function renderSearch() {
        const results = element('graphSearchResults');
        const query = element('graphSearch').value.trim().toLowerCase();
        results.replaceChildren();
        results.classList.toggle('d-none', !query);
        if (!query || !state) return;
        const matches = state.visibleNodes.filter(node => node.searchText.includes(query));
        if (!matches.length) results.textContent = 'Keine passenden Knoten.';
        matches.slice(0, 8).forEach(node => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'graph-search-result btn btn-light border text-start w-100';
            button.textContent = shorten(nodeName(node), 65);
            button.title = node.nodeType === 'Literal' ? nodeName(node) : node.id;
            button.addEventListener('click', () => selectFromControl(node));
            results.append(button);
        });
        if (matches.length > 8) {
            const hint = document.createElement('p');
            hint.className = 'small text-body-secondary mt-2 mb-0';
            hint.textContent = '8 von ' + matches.length + ' Treffern. Verfeinere die Suche.';
            results.append(hint);
        }
    }

    function renderLabels() {
        let labels = element('graphLabels');
        if (!labels) {
            labels = document.createElement('div');
            labels.id = 'graphLabels';
            labels.className = 'graph-labels';
            labels.setAttribute('aria-hidden', 'true');
            element('graphStage').append(labels);
        }
        labels.replaceChildren();
        if (!state || !element('graphLabelsToggle').checked) return;
        const nodes = state.visibleNodes.filter(node => node.nodeType !== 'Literal')
            .sort((a, b) => labelPriority(b) - labelPriority(a)).slice(0, 6);
        nodes.forEach(node => {
            const label = document.createElement('span');
            label.className = 'graph-node-label';
            const className = node.isClass ? 'Klasse' : node.classes[0];
            label.textContent = (className ? className + ' · ' : '') + shorten(nodeName(node), 36);
            label.dataset.nodeId = node.id;
            labels.append(label);
        });
        updateLabelPositions();
    }

    function labelPriority(node) {
        return node.id === selectedId ? 10000 : (node.isClass ? 1000 : 0) + node.degree;
    }

    function updateLabelPositions() {
        const labels = element('graphLabels');
        if (!labels || !graph || !state || typeof graph.graph2ScreenCoords !== 'function') return;
        if (!element('graphLabelsToggle').checked) { labels.replaceChildren(); return; }
        const bounds = element('rdfGraph3d').getBoundingClientRect();
        const occupied = [];
        [...labels.children].forEach(label => {
            const node = state.nodeMap.get(label.dataset.nodeId);
            if (!node) { label.hidden = true; return; }
            const coords = graph.graph2ScreenCoords(node.x || 0, node.y || 0, node.z || 0);
            label.hidden = false;
            const width = label.offsetWidth || Math.min(180, label.textContent.length * 6.6 + 16);
            const height = label.offsetHeight || 30;
            const box = coords && { left: coords.x - width / 2, right: coords.x + width / 2,
                top: coords.y + 14, bottom: coords.y + 14 + height };
            const visible = box && Number.isFinite(coords.x) && Number.isFinite(coords.y)
                && box.left >= 12 && box.right <= bounds.width - 12 && box.top >= 65 && box.bottom <= bounds.height - 70
                && (!(selectedId || hoveredId) || highlightedNodes.has(node.id))
                && !occupied.some(other => box.left < other.right + 8 && box.right > other.left - 8
                    && box.top < other.bottom + 6 && box.bottom > other.top - 6);
            label.hidden = !visible;
            if (visible) {
                occupied.push(box);
                label.style.transform = 'translate(' + Math.round(coords.x) + 'px,' + Math.round(coords.y + 14) + 'px) translateX(-50%)';
            }
            label.classList.toggle('is-active', node.id === selectedId);
        });
    }

    /** Measure the container itself: fullscreen and sidebar changes need no graph-data reload. */
    function resize() {
        if (!graph || panel.classList.contains('d-none')) return;
        const bounds = element('rdfGraph3d').getBoundingClientRect();
        if (bounds.width > 0 && bounds.height > 0) {
            const width = Math.floor(bounds.width);
            const height = Math.floor(bounds.height);
            graph.width(width).height(height);
            const renderer = graph.renderer();
            if (renderer && typeof renderer.setSize === 'function') renderer.setSize(width, height);
            // Renderer setters are debounced; projection must already match the measured viewport.
            const camera = graph.camera();
            camera.aspect = bounds.width / bounds.height;
            camera.updateProjectionMatrix();
        }
        fitOverview();
        updateLabelPositions();
    }

    function scheduleResize() {
        if (resizeFrame !== null) return;
        resizeFrame = window.requestAnimationFrame(() => { resizeFrame = null; resize(); });
    }

    function cancelOverview() {
        if (initialOverviewComplete) overviewPending = false;
    }

    /** Fit simulation coordinates and actual shape radii, never stale scene bounding matrices. */
    function fitOverview() {
        if (!graph || !nodeFactory || !state || !currentDataReady || !overviewPending) return;
        const bounds = element('rdfGraph3d').getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return;
        const overlays = ['.graph-stage-top', '.graph-stage-bottom'].map(selector =>
            panel.querySelector(selector).getBoundingClientRect().height + 24);
        const padding = Math.min(Math.min(bounds.width, bounds.height) * 0.3, Math.max(32, ...overlays));
        const camera = graph.camera();
        const fit = window.RdfGraphFit.calculate(state.nodes, {
            width: bounds.width, height: bounds.height, fov: camera.fov, zoom: 1, padding
        }, nodeFactory.radius);
        if (!fit) return;
        const controls = graph.controls();
        if (!initialOverviewComplete && controls && typeof controls.reset === 'function') controls.reset();
        camera.aspect = bounds.width / bounds.height;
        camera.zoom = 1;
        camera.near = fit.near;
        camera.far = Math.max(20000, fit.far);
        camera.position.set(fit.position.x, fit.position.y, fit.position.z);
        camera.up.set(0, 1, 0);
        if (controls?.target) controls.target.set(fit.target.x, fit.target.y, fit.target.z);
        camera.lookAt(fit.target.x, fit.target.y, fit.target.z);
        camera.updateProjectionMatrix();
        if (controls && typeof controls.update === 'function') controls.update();
        camera.updateMatrixWorld(true);
        element('graphSummary').textContent = state.nodes.length + ' Knoten · ' + state.links.length + ' Verbindungen';
        element('rdfGraph3d').style.visibility = '';
        initialOverviewComplete = true;
    }

    /** Node creation and synchronous warmup finish before this frame or engine-stop callback. */
    function finishInitialLayout() {
        if (!state || !state.nodes.every(node => createdNodes.has(node))) return;
        currentDataReady = true;
        resize();
    }

    function resetView() {
        if (!graph) return;
        clearFocus();
        const controls = graph.controls();
        if (controls && typeof controls.reset === 'function') controls.reset();
        overviewPending = true;
        resize();
    }

    function syncFullscreen(active) {
        expanded = active;
        panel.classList.toggle('graph-fullscreen', active);
        element('fullscreenGraphBtn').setAttribute('aria-expanded', String(active));
        element('fullscreenGraphBtn').querySelector('span').textContent = active ? 'Vollbild beenden' : 'Vollbild';
        document.body.classList.toggle('graph-fullscreen-open', active);
        if (active) {
            previousOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-modal', 'true');
            // Keep the CSS fallback modal to keyboard and assistive-technology users too.
            let ancestor = panel;
            while (ancestor.parentElement && ancestor.parentElement !== document.documentElement) {
                for (const sibling of ancestor.parentElement.children) {
                    if (sibling !== ancestor && !sibling.inert) { sibling.inert = true; inertElements.push(sibling); }
                }
                ancestor = ancestor.parentElement;
            }
            element('fullscreenGraphBtn').focus();
        } else {
            document.body.style.overflow = previousOverflow;
            panel.removeAttribute('role');
            panel.removeAttribute('aria-modal');
            inertElements.forEach(sibling => { sibling.inert = false; });
            inertElements = [];
            if (returnFocus && returnFocus.isConnected) returnFocus.focus();
            returnFocus = null;
        }
        scheduleResize();
    }

    async function exitFullscreen() {
        fullscreenRevision++;
        const nativeFullscreen = document.fullscreenElement === panel;
        if (expanded) syncFullscreen(false);
        if (nativeFullscreen && typeof document.exitFullscreen === 'function') {
            try { await document.exitFullscreen(); } catch (_) { /* Restore the page if the browser rejects exit. */ }
        }
    }

    async function toggleFullscreen() {
        if (expanded) return exitFullscreen();
        const currentRevision = ++fullscreenRevision;
        returnFocus = document.activeElement;
        syncFullscreen(true);
        if (typeof panel.requestFullscreen === 'function') {
            try { await panel.requestFullscreen(); } catch (_) { /* The CSS view remains usable. */ }
            if (currentRevision !== fullscreenRevision && document.fullscreenElement === panel) await exitFullscreen();
        }
    }

    function unavailable() {
        state = null;
        selectedId = null;
        hoveredId = null;
        overviewPending = false;
        initialOverviewComplete = false;
        currentDataReady = false;
        clearInspector();
        if (element('graphLabels')) element('graphLabels').replaceChildren();
        if (graph) graph.pauseAnimation();
        element('rdfGraph3d').classList.add('d-none');
        element('graphSummary').textContent = '3D-Ansicht nicht verfügbar.';
        element('graphContext').textContent = 'Die RDF/XML-Eingabe bleibt erhalten. Klicke auf „Graph anzeigen“, um die 3D-Ansicht erneut zu laden.';
    }

    function hide() {
        revision++;
        state = null;
        selectedId = null;
        hoveredId = null;
        overviewPending = false;
        initialOverviewComplete = false;
        currentDataReady = false;
        if (expanded) exitFullscreen();
        panel.classList.add('d-none');
        element('graphSummary').textContent = 'Kein Graph geladen.';
        clearInspector();
        if (graph) graph.pauseAnimation();
    }

    async function render(data) {
        const currentRevision = ++revision;
        const nodes = Array.isArray(data.graphNodes) ? data.graphNodes : [];
        const links = Array.isArray(data.graphLinks) ? data.graphLinks : [];
        if (!nodes.length || !links.length) return hide();
        if (graph) graph.pauseAnimation();
        state = null;
        currentDataReady = false;
        overviewPending = false;
        initialOverviewComplete = false;
        element('rdfGraph3d').style.visibility = 'hidden';
        panel.classList.remove('d-none');
        element('graphSummary').textContent = '3D-Ansicht wird geladen …';
        let createGraph;
        try { [createGraph, nodeFactory] = await Promise.all([loadLibrary(), window.RdfGraphNodes.load()]); }
        catch (_) { if (currentRevision === revision) unavailable(); return; }
        if (currentRevision !== revision) return;
        state = prepare(nodes, links);
        selectedId = null;
        hoveredId = null;
        currentDataReady = false;
        createdNodes = new WeakSet();
        overviewPending = true;
        clearInspector();
        element('graphSearch').value = '';
        element('graphLabelsToggle').checked = false;
        renderLabels();
        renderSearch();
        element('rdfGraph3d').classList.remove('d-none');
        element('rdfGraph3d').style.visibility = 'hidden';
        window.requestAnimationFrame(() => {
            if (currentRevision !== revision) return;
            try {
                if (!graph) {
                    graph = createGraph()(element('rdfGraph3d'))
                        .backgroundColor('#ffffff')
                        .showNavInfo(false)
                        .nodeLabel(nodeTooltip)
                        .nodeThreeObject(node => {
                            const mesh = nodeFactory.create(node);
                            nodeFactory.update(node, nodeColor(node));
                            if (state && state.nodeMap.get(node.id) === node) createdNodes.add(node);
                            return mesh;
                        })
                        .nodeThreeObjectExtend(false)
                        .nodeVal(node => Math.pow(nodeFactory.radius(node) / 4, 3))
                        .linkColor(linkColor).linkWidth(linkWidth).linkOpacity(0.88)
                        .linkLabel(linkTooltip)
                        .linkDirectionalArrowLength(link => isLiteralLink(link) ? 1.8 : 3.5)
                        .linkDirectionalArrowRelPos(0.88).linkDirectionalArrowColor(linkColor)
                        .linkDirectionalParticles(0)
                        .onNodeClick(selectNode)
                        .onNodeHover(node => { hoveredId = node && state && state.nodeMap.has(node.id) ? node.id : null; updateHighlight(); })
                        .onBackgroundClick(clearFocus)
                        .enableNodeDrag(false)
                        .onEngineTick(updateLabelPositions)
                        .onEngineStop(() => {
                            finishInitialLayout();
                            updateLabelPositions();
                        })
                        .warmupTicks(140).cooldownTicks(0);
                    // Keep literal annotations close to their resource; give the resource backbone more room.
                    const linksForce = graph.d3Force('link');
                    if (linksForce && typeof linksForce.distance === 'function') {
                        linksForce.distance(link => {
                            const source = typeof link.source === 'object' ? link.source : state?.nodeMap.get(endpoint(link.source));
                            const target = typeof link.target === 'object' ? link.target : state?.nodeMap.get(endpoint(link.target));
                            const symbols = (source ? nodeFactory.radius(source) : 0) + (target ? nodeFactory.radius(target) : 0);
                            return Math.max(symbols + 16, isLiteralLink(link) ? 30 : isTypeLink(link) ? 85 : 100);
                        });
                    }
                    const chargeForce = graph.d3Force('charge');
                    if (chargeForce && typeof chargeForce.strength === 'function') {
                        chargeForce.strength(node => node.nodeType === 'Literal' ? -8 : -55);
                    }
                    const controls = graph.controls();
                    // Stop with the gesture so residual inertia cannot disturb a fresh overview.
                    if (controls) controls.staticMoving = true;
                    if (controls && typeof controls.addEventListener === 'function') {
                        controls.addEventListener('change', updateLabelPositions);
                        controls.addEventListener('start', cancelOverview);
                    }
                }
                // Complete layout offscreen, then reveal only a perspective-correct full view.
                resize();
                graph.graphData({ nodes: state.visibleNodes, links: state.visibleLinks });
                updateHighlight();
                graph.resumeAnimation();
                window.requestAnimationFrame(() => {
                    if (currentRevision !== revision) return;
                    finishInitialLayout();
                });
            } catch (_) { if (currentRevision === revision) unavailable(); }
        });
    }

    element('fullscreenGraphBtn').addEventListener('click', toggleFullscreen);
    element('resetGraphViewBtn').addEventListener('click', resetView);
    element('clearGraphFocusBtn').addEventListener('click', clearFocus);
    element('graphSearch').addEventListener('input', renderSearch);
    element('graphLabelsToggle').addEventListener('change', renderLabels);
    window.addEventListener('resize', scheduleResize);
    if (typeof ResizeObserver === 'function') new ResizeObserver(scheduleResize).observe(element('graphStage'));
    document.addEventListener('fullscreenchange', () => {
        if (expanded && document.fullscreenElement !== panel) syncFullscreen(false);
        else scheduleResize();
    });
    document.addEventListener('keydown', event => {
        if (!expanded) return;
        if (event.key === 'Escape') { event.preventDefault(); exitFullscreen(); }
        if (event.key === 'Tab') {
            const controls = [...panel.querySelectorAll('button, input, select, a[href]')]
                .filter(control => !control.disabled && !control.closest('.d-none') && !control.hidden);
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
    });

    window.RdfGraphExplorer = { render, hide, resetView, toggleFullscreen };
})();
