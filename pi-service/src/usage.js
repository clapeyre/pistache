// Read reported numeric usage while forwarding the original SSE bytes unchanged.
export function usageFetch(entries) {
  return async (input, init) => {
    const response = await fetch(input, init);
    const entry = { cost: null, input: null, output: null };
    entries.push(entry);
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
    const decoder = new TextDecoder();
    let buffer = '';
    const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const line = text => {
      if (!text.startsWith('data:')) return;
      try {
        const usage = JSON.parse(text.slice(5)).usage;
        if (!usage) return;
        if (numeric(usage.cost)) entry.cost = usage.cost;
        if (numeric(usage.prompt_tokens)) entry.input = usage.prompt_tokens;
        if (numeric(usage.completion_tokens)) entry.output = usage.completion_tokens;
      } catch {} // Includes [DONE]. No raw chunks are retained.
    };
    const stream = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop();
        for (const item of lines) line(item);
        if (buffer.length > 65536) buffer = ''; // Bound incomplete/malformed frames.
      },
      flush() { buffer += decoder.decode(); if (buffer) line(buffer); }
    }));
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
export function usageSummary(entries) {
  const sum = key => entries.length && entries.every(entry => entry[key] !== null) ? entries.reduce((total, entry) => total + entry[key], 0) : null;
  return { requests: entries.length, prompt_tokens: sum('input'), completion_tokens: sum('output'), cost_usd: sum('cost') };
}
