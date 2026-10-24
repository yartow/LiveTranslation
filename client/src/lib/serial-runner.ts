// Runs async jobs strictly one after another, in the order they were requested, whether or not an
// earlier one failed. Used where the *last request must win* — e.g. two quick microphone switches,
// where whichever getUserMedia() happens to resolve last would otherwise decide the device.

export function createSerialRunner() {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(job: () => Promise<T>): Promise<T> {
    const result = tail.then(job, job);
    tail = result.catch(() => {});
    return result;
  };
}
