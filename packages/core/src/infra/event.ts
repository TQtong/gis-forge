// ============================================================
// infra/event.ts — 类型安全事件总线（自研实现）
// 提供泛型事件发射器，事件名与回调参数类型在编译时关联。
// 支持 on / off / once / emit 四种操作。
// 零外部依赖。
// ============================================================

// ======================== 类型定义 ========================

/**
 * 事件处理器函数类型。
 * 泛型 T 由 EventMap 中的事件类型推导。
 */
type EventHandler<T> = (data: T) => void;

// ======================== 公共类 ========================

/**
 * 类型安全的事件发射器。
 * 泛型参数 T 是一个事件映射类型，键为事件名称，值为事件数据类型。
 * 编译时确保事件名和回调参数类型匹配，拼写错误在编译期即可捕获。
 *
 * 内部使用 Map<string, Set<Function>> 存储处理器，
 * Set 保证同一处理器不会被重复注册，且移除操作 O(1)。
 *
 * @example
 * // 定义事件映射类型
 * interface MyEvents {
 *   click: { x: number; y: number };
 *   resize: { width: number; height: number };
 *   close: void;
 * }
 *
 * const emitter = new EventEmitter<MyEvents>();
 *
 * emitter.on('click', (data) => {
 *   console.log(data.x, data.y); // data 自动推导为 { x: number; y: number }
 * });
 *
 * emitter.emit('click', { x: 100, y: 200 });
 */
export class EventEmitter<T extends Record<string, unknown>> {
    /**
     * 事件处理器存储。
     * 外层 Map 的 key 是事件名称，value 是处理器集合。
     * 使用 Set 确保同一个函数引用不会被重复注册。
     */
    private readonly _handlers: Map<string, Set<Function>> = new Map();

    /**
     * 一次性处理器的包装函数映射。
     * once() 注册的处理器需要在触发后自动移除，
     * 因此需要用包装函数替代原始函数注册到 _handlers 中。
     * 这个 Map 记录原始函数 → 包装函数的映射，
     * 以便 off() 能通过原始函数引用移除一次性处理器。
     */
    private readonly _onceWrappers: Map<Function, Function> = new Map();

    /**
     * 注册事件处理器。
     * 同一个函数引用对同一事件只会注册一次（Set 语义）。
     *
     * @param event - 事件名称（必须是 T 中定义的键）
     * @param handler - 事件处理器函数
     * @returns this 引用，便于链式调用
     *
     * @example
     * emitter.on('click', handleClick).on('resize', handleResize);
     */
    on<K extends string & keyof T>(event: K, handler: EventHandler<T[K]>): this {
        let handlers = this._handlers.get(event);

        // 该事件首次注册时创建 Set
        if (handlers === undefined) {
            handlers = new Set();
            this._handlers.set(event, handlers);
        }

        handlers.add(handler);
        return this;
    }

    /**
     * 移除事件处理器。
     * 如果未指定 handler，移除该事件的所有处理器。
     *
     * @param event - 事件名称
     * @param handler - 要移除的处理器（可选）
     * @returns this 引用，便于链式调用
     *
     * @example
     * emitter.off('click', handleClick); // 移除特定处理器
     * emitter.off('click');             // 移除 click 事件的所有处理器
     */
    off<K extends string & keyof T>(event: K, handler?: EventHandler<T[K]>): this {
        if (handler === undefined) {
            // 移除该事件的所有处理器
            this._handlers.delete(event);
            return this;
        }

        const handlers = this._handlers.get(event);
        if (handlers === undefined) {
            return this;
        }

        // 直接尝试移除原始函数
        handlers.delete(handler);

        // 也检查是否有对应的 once 包装函数需要移除
        const wrapper = this._onceWrappers.get(handler);
        if (wrapper !== undefined) {
            handlers.delete(wrapper);
            this._onceWrappers.delete(handler);
        }

        // 如果集合为空，清理 Map 条目
        if (handlers.size === 0) {
            this._handlers.delete(event);
        }

        return this;
    }

    /**
     * 注册一次性事件处理器。
     * 处理器在第一次触发后自动移除，不会再次触发。
     *
     * @param event - 事件名称
     * @param handler - 事件处理器函数
     * @returns this 引用，便于链式调用
     *
     * @example
     * emitter.once('load', () => {
     *   console.log('loaded!'); // 只会打印一次
     * });
     */
    once<K extends string & keyof T>(event: K, handler: EventHandler<T[K]>): this {
        // 创建包装函数：触发时先移除自身再调用原始处理器
        const wrapper = (data: T[K]) => {
            // 先从处理器集合中移除包装函数
            this.off(event, wrapper as EventHandler<T[K]>);
            // 清理 once 映射
            this._onceWrappers.delete(handler);
            // 调用原始处理器
            handler(data);
        };

        // 记录原始函数 → 包装函数的映射
        this._onceWrappers.set(handler, wrapper);

        // 注册包装函数
        return this.on(event, wrapper as EventHandler<T[K]>);
    }

    /**
     * 触发事件，按注册顺序调用所有处理器。
     * 处理器执行过程中的异常会被捕获并通过 console.error 输出，
     * 不会阻止后续处理器的执行。
     *
     * @param event - 事件名称
     * @param data - 事件数据（类型由 T[K] 确定）
     * @returns this 引用，便于链式调用
     *
     * @example
     * emitter.emit('click', { x: 100, y: 200 });
     */
    emit<K extends string & keyof T>(event: K, data: T[K]): this {
        const handlers = this._handlers.get(event);

        // 没有处理器时快速返回
        if (handlers === undefined || handlers.size === 0) {
            return this;
        }

        // 复制处理器集合再遍历——防止处理器内部修改集合导致迭代异常
        // （例如 once 处理器在触发时会移除自身）
        const snapshot = Array.from(handlers);

        for (let i = 0; i < snapshot.length; i++) {
            try {
                (snapshot[i] as EventHandler<T[K]>)(data);
            } catch (err) {
                // 捕获处理器异常，防止一个处理器的错误影响其他处理器
                console.error(
                    `[EventEmitter] Handler error for event "${event}":`,
                    err,
                );
            }
        }

        return this;
    }

    /**
     * 检查指定事件是否有注册的处理器。
     *
     * @param event - 事件名称
     * @returns 是否有处理器
     */
    hasListeners<K extends string & keyof T>(event: K): boolean {
        const handlers = this._handlers.get(event);
        return handlers !== undefined && handlers.size > 0;
    }

    /**
     * 获取指定事件的处理器数量。
     *
     * @param event - 事件名称
     * @returns 处理器数量
     */
    listenerCount<K extends string & keyof T>(event: K): number {
        const handlers = this._handlers.get(event);
        return handlers !== undefined ? handlers.size : 0;
    }

    /**
     * 移除所有事件的所有处理器。
     * 用于销毁时清理资源。
     */
    removeAllListeners(): void {
        this._handlers.clear();
        this._onceWrappers.clear();
    }
}
