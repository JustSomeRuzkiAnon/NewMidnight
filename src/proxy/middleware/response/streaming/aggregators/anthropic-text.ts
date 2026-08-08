import { OpenAIChatCompletionStreamEvent } from "../index";

export type AnthropicTextCompletionResponse = {
  completion: string;
  stop_reason: string;
  truncated: boolean;
  stop: any;
  model: string;
  log_id: string;
  exception: null;
};

/**
 * Given a list of OpenAI chat completion events, compiles them into a single
 * finalized Anthropic completion response so that non-streaming middleware
 * can operate on it as if it were a blocking response.
 */
export function mergeEventsForAnthropicText(
  events: OpenAIChatCompletionStreamEvent[]
): AnthropicTextCompletionResponse {
  let merged: AnthropicTextCompletionResponse = {
    log_id: "",
    exception: null,
    model: "",
    completion: "",
    stop_reason: "",
    truncated: false,
    stop: null,
  };
  merged = events.reduce((acc, event, i) => {
    // The first event will only contain role assignment and response metadata
    if (i === 0) {
      acc.log_id = event.id;
      acc.model = event.model;
      acc.completion = "";
      acc.stop_reason = "";
      return acc;
    }

    // Events without choices (e.g. a final usage-only chunk) carry no content.
    const choice = event.choices?.[0];
    if (choice) {
      acc.stop_reason = choice.finish_reason ?? "";
      if (choice.delta?.content) {
        acc.completion += choice.delta.content;
      }
    }

    return acc;
  }, merged);
  return merged;
}
