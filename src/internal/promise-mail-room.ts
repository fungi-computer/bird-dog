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
  const runtime = await Effect.runPromise(
    make({
      stage: (mail: readonly BirdDogMail[]) =>
        Effect.tryPromise({
          try: () => options.stage(mail),
          catch: (cause) => new BirdDogError("mail staging failed", { cause }),
        }),
      now: options.now,
    }),
  );

  return Object.freeze({
    fanOut: (settlement) => runPromise(runtime.fanOut(settlement)),
  });
};
