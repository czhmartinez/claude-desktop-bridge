interface WaitingConsumer<T> {
  resolve(result: IteratorResult<T>): void;
  reject(error: Error): void;
}

export class AsyncInputQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly consumers: WaitingConsumer<T>[] = [];
  private closed = false;
  private failure: Error | undefined;

  get size(): number {
    return this.values.length;
  }

  push(value: T): void {
    if (this.closed) throw new Error("Input queue is closed");
    const consumer = this.consumers.shift();
    if (consumer) {
      consumer.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    for (const consumer of this.consumers.splice(0)) {
      if (error) consumer.reject(error);
      else consumer.resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.failure) throw this.failure;
        if (this.closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.consumers.push({ resolve, reject });
        });
      },
    };
  }
}
