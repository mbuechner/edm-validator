// Run: node --test src/test/js/graph-geometry.test.cjs
// These tests use Three's actual camera and meshes, without a browser or WebGL context.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../..');
const assets = path.join(root, 'src/main/resources/static');
const context = vm.createContext({ window: {} });
let THREE;

test.before(async () => {
    const source = fs.readFileSync(path.join(assets, 'vendor/three-core-0.183.2.min.js'), 'utf8');
    THREE = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    for (const name of ['graph-fit.js', 'graph-nodes.js']) {
        vm.runInContext(fs.readFileSync(path.join(assets, name), 'utf8'), context, { filename: name });
    }
});

/** Project all shape-enclosing corners using the real camera, independently of the fit formula. */
function assertFits(nodes, viewport, radiusForNode) {
    const fit = context.window.RdfGraphFit.calculate(nodes, viewport, radiusForNode);
    assert.ok(fit, 'a finite graph in a usable viewport has an overview');
    const camera = new THREE.PerspectiveCamera(viewport.fov || 50,
        viewport.width / viewport.height, fit.near, fit.far);
    camera.zoom = viewport.zoom || 1;
    camera.position.set(fit.position.x, fit.position.y, fit.position.z);
    camera.lookAt(fit.target.x, fit.target.y, fit.target.z);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const padding = viewport.padding ?? 60;
    for (const node of nodes) {
        const radius = radiusForNode(node);
        for (const dx of [-radius, radius]) for (const dy of [-radius, radius]) for (const dz of [-radius, radius]) {
            const point = new THREE.Vector3(node.x + dx, node.y + dy, node.z + dz).project(camera);
            const x = (point.x + 1) * viewport.width / 2;
            const y = (1 - point.y) * viewport.height / 2;
            const description = `node ${node.id || ''}, corner (${dx}, ${dy}, ${dz}), viewport ${viewport.width}x${viewport.height}`;
            assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(point.z), description);
            assert.ok(x >= padding - 1e-6 && x <= viewport.width - padding + 1e-6,
                `${description}: horizontal extent ${x} includes its shape and padding`);
            assert.ok(y >= padding - 1e-6 && y <= viewport.height - padding + 1e-6,
                `${description}: vertical extent ${y} includes its shape and padding`);
            assert.ok(point.z > -1 && point.z < 1, `${description}: its complete depth lies between clipping planes`);
        }
    }
    return fit;
}

function categoryNodes(degree = 12) {
    return [
        { id: 'cho', nodeType: 'IRI', classes: ['ProvidedCHO'], degree },
        { id: 'class', nodeType: 'IRI', classes: [], isClass: true, degree },
        { id: 'resource', nodeType: 'IRI', classes: ['WebResource'], degree },
        { id: 'place', nodeType: 'IRI', classes: ['Place'], degree },
        { id: 'agent', nodeType: 'IRI', classes: ['Agent'], degree },
        { id: 'literal', nodeType: 'Literal', classes: [], degree }
    ];
}

function assertMeshWithinRadius(mesh, node, radius) {
    mesh.updateMatrixWorld(true);
    mesh.traverse(object => {
        const positions = object.geometry?.getAttribute('position');
        if (!positions) return;
        for (let vertex = 0; vertex < positions.count; vertex++) {
            const point = new THREE.Vector3().fromBufferAttribute(positions, vertex).applyMatrix4(object.matrixWorld);
            assert.ok(point.length() <= radius + 1e-5,
                `${node.id}: even rotated mesh vertices and outlines stay within the camera-fit radius`);
        }
    });
}

test('the overview contains asymmetric, deep graphs in landscape and narrow portrait viewports', () => {
    const nodes = [
        { id: 'near-left', x: -470, y: 60, z: 930, radius: 24 },
        { id: 'back-right', x: 1560, y: -730, z: -1440, radius: 51 },
        { id: 'high', x: 410, y: 1280, z: 350, radius: 13 },
        { id: 'remote', x: 3650, y: 170, z: -900, radius: 7 }
    ];
    for (const [width, height] of [[1120, 420], [320, 900], [1900, 350], [240, 600]]) {
        assertFits(nodes, { width, height, padding: 24 }, node => node.radius);
    }
});

test('single large shapes, camera zoom and graphs beyond the default far plane are fully framed', () => {
    assertFits([{ id: 'large', x: 1900, y: -2200, z: -500, radius: 240 }],
        { width: 640, height: 480, padding: 36, fov: 32, zoom: 2.75, near: 20 }, node => node.radius);
    const distant = [{ x: -5000, y: 9000, z: 25000, radius: 400 },
        { x: 17000, y: -2000, z: -47000, radius: 750 }];
    const fit = assertFits(distant, { width: 960, height: 540, padding: 40 }, node => node.radius);
    assert.ok(fit.far > 10000, 'the camera far plane grows with the graph instead of clipping its back');
});

test('unusable bounds never expose a fabricated or non-finite overview', () => {
    const calculate = context.window.RdfGraphFit.calculate;
    const node = { x: 1, y: 2, z: 3 };
    const viewport = { width: 800, height: 600, padding: 30 };
    assert.equal(calculate([], viewport), null);
    assert.equal(calculate([node], { ...viewport, width: 0 }), null);
    assert.equal(calculate([node], { ...viewport, height: 0 }), null);
    assert.equal(calculate([node], { ...viewport, width: 60 }), null);
    for (const override of [{ width: NaN }, { height: Infinity }, { fov: 0 }, { fov: 180 },
        { zoom: 0 }, { near: 0 }, { padding: -1 }]) {
        assert.equal(calculate([node], { ...viewport, ...override }), null);
    }
    for (const invalid of [{ ...node, x: undefined }, { ...node, y: NaN }, { ...node, z: Infinity }, null]) {
        assert.equal(calculate([invalid], viewport), null);
    }
    for (const radius of [-1, NaN, Infinity]) {
        assert.equal(calculate([node], viewport, () => radius), null);
    }
    assertFits([{ x: 0, y: 0, z: 0 }], viewport, () => 0);
});

test('real node meshes provide recognizable shapes and fit inside their declared world radius', () => {
    const factory = context.window.RdfGraphNodes.createFactory(THREE);
    const nodes = categoryNodes();
    const meshes = nodes.map(node => factory.create(node));
    assert.ok(new Set(meshes.slice(0, 5).map(mesh => mesh.geometry.type)).size >= 5,
        'the main RDF categories remain distinguishable without relying on color');
    assert.ok(factory.radius(nodes[5]) < factory.radius(nodes[2]) / 2,
        'literal values are visibly smaller than resources');
    assert.ok(factory.radius(nodes[0]) > factory.radius(nodes[2]),
        'the main cultural heritage object stands out from a generic resource');
    assert.equal(meshes[4].geometry.type, 'DodecahedronGeometry',
        'agents use a faceted polyhedron with a clearly different silhouette');
    assert.equal(meshes[3].geometry.type, 'TorusGeometry', 'places use a symmetric ring');
    const placeGeometry = meshes[3].geometry;
    placeGeometry.computeBoundingBox();
    const placeBounds = placeGeometry.boundingBox;
    for (const axis of ['x', 'y', 'z']) {
        assert.ok(Math.abs(placeBounds.min[axis] + placeBounds.max[axis]) < 1e-5,
            `the place ring has a symmetric ${axis} extent around its node position`);
    }
    const ringPositions = placeGeometry.getAttribute('position');
    for (let vertex = 0; vertex < ringPositions.count; vertex++) {
        assert.ok(Math.hypot(ringPositions.getX(vertex), ringPositions.getY(vertex)) > factory.radius(nodes[3]) / 3,
            'the place ring keeps an open, recognizable center');
    }
    meshes.forEach((mesh, index) => {
        assert.equal(mesh.isMesh, true);
        assert.notEqual(mesh.geometry.type, 'ConeGeometry', 'every category has a balanced symbol');
        assert.notEqual(mesh.geometry.type, 'CylinderGeometry', 'the actor is a recognizable faceted solid');
        assert.equal(mesh.material.isMeshBasicMaterial, true, 'lighting must not alter the DDB node colors');
        assertMeshWithinRadius(mesh, nodes[index], factory.radius(nodes[index]));
    });
    assert.equal(meshes[0].material.color.getHexString(), 'a5003b', 'the primary object uses DDB magenta');
    assert.ok(new Set(meshes.map(mesh => mesh.material.color.getHexString())).size >= 4,
        'the overview has distinct tones as well as distinct shapes');
    const shape = meshes[0].geometry;
    const material = meshes[0].material;
    factory.update(nodes[0], '#727579');
    assert.equal(meshes[0].geometry, shape, 'emphasis preserves the node geometry');
    assert.equal(meshes[0].material, material, 'emphasis updates the existing material');
    assert.equal(material.color.getHexString(), '727579');
});

test('every active category color remains legible against the white graph background', () => {
    const COLORS = context.window.RdfGraphNodes.COLORS;
    for (const category of ['providedCho', 'resource', 'rdfClass', 'place', 'agent', 'literal']) {
        const hex = COLORS[category];
        assert.match(hex, /^#[0-9a-f]{6}$/i);
        const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
            .map(component => component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4);
        const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        const contrast = 1.05 / (luminance + 0.05);
        assert.ok(contrast >= 3, `${category} ${hex} needs at least 3:1 contrast on white, received ${contrast.toFixed(2)}:1`);
    }
});

test('connection degree changes node size visibly while hubs and invalid degrees keep safe bounded radii', () => {
    const factory = context.window.RdfGraphNodes.createFactory(THREE);
    for (const node of categoryNodes(0)) {
        const radius = degree => factory.radius({ ...node, degree });
        assert.ok(radius(1) > radius(0), `${node.id}: its first connection increases the radius`);
        assert.ok(radius(8) > radius(1), `${node.id}: more connected nodes are larger within the same category`);
        assert.ok(radius(16) > radius(8), `${node.id}: connection degree remains visually informative`);
        assert.ok(radius(16) > radius(0) * 1.25, `${node.id}: size differences are perceptible`);
        assert.equal(radius(1e6), radius(Number.MAX_SAFE_INTEGER), `${node.id}: large hub size is capped`);
        assert.ok(radius(1e6) < radius(0) * 2, `${node.id}: hubs cannot overwhelm the other categories`);
        assert.equal(radius('8'), radius(8));
        for (const invalid of [undefined, null, NaN, Infinity, -Infinity, -5, 'invalid', {}]) {
            assert.equal(radius(invalid), radius(0), `${node.id}: invalid degrees retain its finite category radius`);
        }
    }
});

test('the largest degree-scaled meshes remain inside the fitted camera in both viewport orientations', () => {
    const factory = context.window.RdfGraphNodes.createFactory(THREE);
    const nodes = categoryNodes(1e6).map((node, index) => ({ ...node,
        x: index * 140 - 230, y: index % 2 ? -160 : 210, z: index * 190 - 400 }));
    for (const node of nodes) {
        assertMeshWithinRadius(factory.create(node), node, factory.radius(node));
    }
    for (const [width, height] of [[1100, 620], [320, 800]]) {
        assertFits(nodes, { width, height, padding: 32 }, factory.radius);
    }
});
