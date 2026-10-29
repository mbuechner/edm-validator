/* DDB node symbols, kept separate from graph layout and camera interaction. */
(function () {
    'use strict';

    // DDB Styleguide, pages 3–4: primary red/blue hues and high-contrast neutral grays.
    const COLORS = Object.freeze({
        providedCho: '#a5003b', resource: '#2d4694', rdfClass: '#383838',
        place: '#ec0a3c', agent: '#0096cc', literal: '#727579', muted: '#727579'
    });
    // Capture this script's URL while it is executing, before an asynchronous import starts.
    const scriptUrl = typeof document === 'undefined' ? null
        : document.currentScript?.src || document.baseURI;
    let factoryPromise = null;

    function category(node) {
        if (node.nodeType === 'Literal') return 'literal';
        if (node.isClass) return 'rdfClass';
        const classes = (node.classes || []).join(' ').toLowerCase();
        if (classes.includes('providedcho')) return 'providedCho';
        if (classes.includes('place')) return 'place';
        if (classes.includes('agent') || classes.includes('person') || classes.includes('organization')) return 'agent';
        return 'resource';
    }

    /**
     * Encloses the complete symbol, including its outline. Within each node category,
     * more connections in the loaded graph increase the radius by at most 55%.
     * Size describes connectivity, not data quality or the resource's importance.
     */
    function radius(node) {
        const rawDegree = Number(node.degree);
        const degree = Number.isFinite(rawDegree) ? Math.max(0, rawDegree) : 0;
        const growth = 1 + Math.min(0.55, Math.log2(1 + degree) * 0.12);
        let base;
        switch (category(node)) {
            case 'literal': base = 3; break;
            case 'providedCho': base = 16; break;
            case 'rdfClass': base = 14; break;
            case 'place':
            case 'agent': base = 11; break;
            default: base = 8;
        }
        return base * growth;
    }

    /**
     * Creates symbols using public Three.js APIs; no DOM or WebGL context is needed.
     * Each mesh owns its geometry and materials, which the graph releases on removal.
     */
    function createFactory(THREE) {
        const meshes = new WeakMap();

        function create(node) {
            const kind = category(node);
            let geometry;
            switch (kind) {
                case 'providedCho': geometry = new THREE.BoxGeometry(1, 1, 1); break;
                case 'rdfClass': geometry = new THREE.OctahedronGeometry(1); break;
                case 'place': geometry = new THREE.TorusGeometry(1, 0.28, 10, 28); break;
                case 'agent': geometry = new THREE.DodecahedronGeometry(1); break;
                default: geometry = new THREE.SphereGeometry(1, kind === 'literal' ? 8 : 16, 10);
            }

            // Equal physical radii mean that both camera fitting and arrow spacing can
            // use radius(node), regardless of a geometry's native dimensions or rotation.
            geometry.computeBoundingSphere();
            const bounds = geometry.boundingSphere;
            geometry.translate(-bounds.center.x, -bounds.center.y, -bounds.center.z);
            // Leave a tiny margin for Float32 vertex rounding, keeping radius a bound.
            const scale = radius(node) * (1 - 1e-6) / bounds.radius;
            geometry.scale(scale, scale, scale);
            geometry.computeBoundingSphere();

            const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
                color: COLORS[kind], toneMapped: false
            }));
            if (kind === 'providedCho') mesh.rotation.set(Math.PI / 9, Math.PI / 7, 0);
            if (kind === 'agent') mesh.rotation.set(Math.PI / 12, Math.PI / 10, 0);

            // Edges keep solid silhouettes legible without light-dependent color shifts.
            if (kind !== 'resource' && kind !== 'literal' && kind !== 'place') {
                const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 20),
                    new THREE.LineBasicMaterial({
                        color: '#ffffff', transparent: true, opacity: 0.7,
                        depthWrite: false, toneMapped: false
                    }));
                mesh.add(outline);
            }
            meshes.set(node, mesh);
            return mesh;
        }

        /** Update an owned mesh in place so highlighting never rebuilds or moves nodes. */
        function update(node, color) {
            const mesh = meshes.get(node);
            if (!mesh) return;
            mesh.material.color.set(color);
            mesh.children.forEach(outline => { outline.material.opacity = color === COLORS.muted ? 0.25 : 0.7; });
        }

        return Object.freeze({ create, update, radius, category });
    }

    function load() {
        if (!factoryPromise) {
            const base = scriptUrl || document.baseURI;
            const url = new URL('./vendor/three-core-0.183.2.min.js', base).href;
            factoryPromise = import(url).then(createFactory).catch(error => {
                factoryPromise = null;
                throw error;
            });
        }
        return factoryPromise;
    }

    window.RdfGraphNodes = Object.freeze({ COLORS, category, radius, createFactory, load });
}());
