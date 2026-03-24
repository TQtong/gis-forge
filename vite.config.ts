import { defineConfig } from 'vite';

export default defineConfig({
    define: {
        __DEV__: JSON.stringify(true),
    },
});
