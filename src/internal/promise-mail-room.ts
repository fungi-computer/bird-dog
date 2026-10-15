import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import type { BirdDogApi, BirdDogMail, BirdDogRuntime } from "../index.js";
import { BirdDogError, make } from "../effect.js";

const runPromise = <Value>(
  effect: Effect.Effect<Value, BirdDogError>,
): Promise<Value> =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    return Promise.reject(
      failure instanceof Error ? failure : new BirdDogError("mail room failed"),
    );
  });

/** Lift Promise host ports once into BirdDog's Effect-owned mail room. */
export const createPromiseBirdDog: BirdDogApi["make"] = async (
  options,
): Promise<BirdDogRuntime> => {
  const readOutbox = options.outbox.read;
  const readPort = {
    read: (key: string) =>
      Effect.tryPromise({
        try: () => readOutbox(key),
        catch: (cause) => new BirdDogError("outbox read failed", { cause }),
      }),
  };
  const runtime = await Effect.runPromise(
    make({
      outbox: {
        ...readPort,
        put: (key, value) =>
          Effect.tryPromise({
            try: () => options.outbox.put(key, value),
            catch: (cause) =>
              new BirdDogError("outbox write failed", { cause }),
          }),
        list: (limit, afterKey) =>
          Effect.tryPromise({
            try: () => options.outbox.list(limit, afterKey),
            catch: (cause) => new BirdDogError("outbox read failed", { cause }),
          }),
        delete: (key) =>
          Effect.tryPromise({
            try: () => options.outbox.delete(key),
            catch: (cause) =>
              new BirdDogError("outbox delete failed", { cause }),
          }),
      },
      post: (mail: BirdDogMail) =>
        Effect.tryPromise({
          try: () => options.post(mail),
          catch: (cause) =>
            new BirdDogError("mail transport failed", { cause }),
        }),
      scheduleWake: (at) =>
        Effect.tryPromise({
          try: () => options.scheduleWake(at),
          catch: (cause) =>
            new BirdDogError("wake scheduling failed", { cause }),
        }),
      now: options.now,
    }),
  );

  return Object.freeze({
    fanOut: (settlement) => runPromise(runtime.fanOut(settlement)),
    drainOutbox: () => runPromise(runtime.drainOutbox()),
  });
};
