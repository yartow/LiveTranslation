import { pipeline, env } from '@huggingface/transformers';

// Fetch models from Hugging Face CDN, never from local filesystem
env.allowLocalModels = false;

// Use `any` to avoid the union-signature incompatibility in the pipeline overloads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transcriber: any = null;
let loadedModel = '';

self.onmessage = async (e: MessageEvent) => {
  const { type } = e.data as { type: string };

  if (type === 'load') {
    const modelSize: string = e.data.modelSize ?? 'tiny';
    const modelId = `Xenova/whisper-${modelSize}`;
    try {
      if (loadedModel !== modelId) {
        // Cast pipeline to any to avoid the union-type call signature conflict.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transcriber = await (pipeline as any)('automatic-speech-recognition', modelId, {
          progress_callback: (p: Record<string, unknown>) => {
            self.postMessage({ type: 'progress', ...p });
          },
        });
        loadedModel = modelId;
      }
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err) });
    }
    return;
  }

  if (type === 'transcribe') {
    if (!transcriber) {
      self.postMessage({ type: 'error', message: 'Model not loaded' });
      return;
    }
    const { audio, language, chunkIndex } = e.data as {
      audio: Float32Array;
      language: string;
      chunkIndex: number;
    };
    try {
      const result = await transcriber(audio, {
        language: language !== 'auto' ? language : undefined,
        task: 'transcribe',
      });
      const text = (Array.isArray(result)
        ? (result[0] as { text: string }).text
        : (result as { text: string }).text
      ).trim();
      self.postMessage({ type: 'result', text, chunkIndex });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err) });
    }
  }
};
