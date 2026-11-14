// Makes the three.js JSX elements (<mesh>, <group> and so on) known in every
// component, including those that never import from the 3D library directly.
/// <reference types="@react-three/fiber" />

// Stylesheets are imported for their side effects only.
declare module "*.css";
