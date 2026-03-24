/// <reference types="vite/client" />

declare const __DEV__: boolean;

declare module '*.wgsl?raw' {
  const content: string;
  export default content;
}
