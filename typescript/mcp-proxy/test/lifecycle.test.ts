import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { wireLifecycle, type LifecycleTarget } from "../src/lifecycle.js";

function makeTarget(close?: () => Promise<void>): LifecycleTarget & { closeFn: ReturnType<typeof vi.fn> } {
  const closeFn = vi.fn(close ?? (async () => undefined));
  return { server: {}, close: closeFn, closeFn };
}

function makeIO() {
  return { proc: new EventEmitter(), stdin: new EventEmitter(), exit: vi.fn() };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("wireLifecycle", () => {
  it("shuts down on stdin end: closes the proxy and exits 0", async () => {
    const target = makeTarget();
    const io = makeIO();
    wireLifecycle(target, io);

    io.stdin.emit("end");
    await flush();

    expect(target.closeFn).toHaveBeenCalledTimes(1);
    expect(io.exit).toHaveBeenCalledWith(0);
  });

  it("shuts down on stdin close", async () => {
    const target = makeTarget();
    const io = makeIO();
    wireLifecycle(target, io);

    io.stdin.emit("close");
    await flush();

    expect(target.closeFn).toHaveBeenCalledTimes(1);
    expect(io.exit).toHaveBeenCalledWith(0);
  });

  it("shuts down when the server transport closes", async () => {
    const target = makeTarget();
    const io = makeIO();
    wireLifecycle(target, io);

    expect(target.server.onclose).toBeTypeOf("function");
    target.server.onclose!();
    await flush();

    expect(target.closeFn).toHaveBeenCalledTimes(1);
    expect(io.exit).toHaveBeenCalledWith(0);
  });

  it("shuts down once even when multiple termination events fire", async () => {
    const target = makeTarget();
    const io = makeIO();
    wireLifecycle(target, io);

    io.stdin.emit("end");
    io.stdin.emit("close");
    io.proc.emit("SIGTERM");
    await flush();

    expect(target.closeFn).toHaveBeenCalledTimes(1);
  });

  it("exits 130 immediately on a second signal while shutdown is in progress", async () => {
    let releaseClose!: () => void;
    const target = makeTarget(() => new Promise<void>((resolve) => (releaseClose = resolve)));
    const io = makeIO();
    wireLifecycle(target, io);

    io.proc.emit("SIGINT");
    await flush();
    expect(target.closeFn).toHaveBeenCalledTimes(1);
    expect(io.exit).not.toHaveBeenCalled(); // close still pending

    io.proc.emit("SIGINT");
    expect(io.exit).toHaveBeenCalledWith(130);

    releaseClose();
    await flush();
    expect(io.exit).toHaveBeenCalledWith(0);
  });

  it("exits 0 even if close() rejects", async () => {
    const target = makeTarget(async () => {
      throw new Error("close failed");
    });
    const io = makeIO();
    wireLifecycle(target, io);

    io.stdin.emit("end");
    await flush();

    expect(io.exit).toHaveBeenCalledWith(0);
  });
});
