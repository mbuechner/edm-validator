// The graph renderer, controls and custom symbols share one Three.js module.
export { default } from '3d-force-graph';
import {
    BoxGeometry, DodecahedronGeometry, EdgesGeometry, Euler, LineBasicMaterial,
    LineSegments, Mesh, MeshBasicMaterial, OctahedronGeometry, PerspectiveCamera,
    SphereGeometry, TorusGeometry, Vector3
} from 'three';

export const THREE = Object.freeze({
    BoxGeometry, DodecahedronGeometry, EdgesGeometry, Euler, LineBasicMaterial,
    LineSegments, Mesh, MeshBasicMaterial, OctahedronGeometry, PerspectiveCamera,
    SphereGeometry, TorusGeometry, Vector3
});
