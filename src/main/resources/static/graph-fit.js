/* Perspective fitting uses current simulation coordinates, independently of rendered mesh matrices. */
(function () {
    'use strict';

    /**
     * Calculate a front-facing overview of every node, including the full extent of its shape.
     *
     * Coordinates and radii use graph/world units. The camera looks along negative Z: a node's
     * largest Z value is nearest to the camera and therefore determines the required distance.
     * Width, height and the symmetric padding use CSS pixels from the actual graph viewport.
     * The vertical field of view is supplied in degrees and converted to radians for tangent;
     * camera zoom narrows that field of view. Radius must enclose the entire node mesh.
     *
     * No rendered bounding box is read: the force engine updates coordinates before its meshes
     * and their world matrices, so those bounds can still describe the preceding frame.
     * Return null until all coordinates and viewport dimensions permit a finite, usable fit.
     */
    function calculate(nodes, { width, height, fov = 50, zoom = 1, near = 0.1, padding = 60 } = {},
        radiusForNode = () => 0) {
        if (!Array.isArray(nodes) || !nodes.length || typeof radiusForNode !== 'function'
            || ![width, height, fov, zoom, near, padding].every(Number.isFinite)
            || width <= 0 || height <= 0 || fov <= 0 || fov >= 180 || zoom <= 0
            || near <= 0 || padding < 0 || width <= padding * 2 || height <= padding * 2) return null;

        const min = { x: Infinity, y: Infinity, z: Infinity };
        const max = { x: -Infinity, y: -Infinity, z: -Infinity };
        for (const node of nodes) {
            if (!node || ![node.x, node.y, node.z].every(Number.isFinite)) return null;
            const radius = radiusForNode(node);
            if (!Number.isFinite(radius) || radius < 0) return null;
            for (const axis of ['x', 'y', 'z']) {
                min[axis] = Math.min(min[axis], node[axis] - radius);
                max[axis] = Math.max(max[axis], node[axis] + radius);
            }
        }

        const target = {};
        const halfSize = {};
        for (const axis of ['x', 'y', 'z']) {
            // Halving before addition/subtraction avoids overflowing a finite pair of bounds.
            target[axis] = min[axis] / 2 + max[axis] / 2;
            halfSize[axis] = max[axis] / 2 - min[axis] / 2;
        }

        const tangentVertical = Math.tan(fov * Math.PI / 360) / zoom;
        const tangentHorizontal = tangentVertical * width / height;
        const availableWidth = 1 - padding * 2 / width;
        const availableHeight = 1 - padding * 2 / height;
        const distance = halfSize.z + Math.max(
            halfSize.x / (tangentHorizontal * availableWidth),
            halfSize.y / (tangentVertical * availableHeight),
            1
        ) * 1.03 + Math.max(1, near * 2);
        const position = { x: target.x, y: target.y, z: target.z + distance };
        // The far plane includes the back of the box, with room for floating-point rounding.
        const far = distance + halfSize.z + Math.max(10, distance * 0.1);
        if (![...Object.values(target), ...Object.values(position), far].every(Number.isFinite)
            || !Number.isFinite(distance) || distance <= halfSize.z + near) return null;

        return { position, target, near, far };
    }

    window.RdfGraphFit = Object.freeze({ calculate });
}());
