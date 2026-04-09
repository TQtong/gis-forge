import { defineConfig } from 'vitest/config';

export default defineConfig({
    define: {
        __DEV__: JSON.stringify(false),
    },
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        globals: false,
        // GPU / DOM 测试会跳过（Node 环境无 WebGPU），其它单元测试正常跑
    },
});
