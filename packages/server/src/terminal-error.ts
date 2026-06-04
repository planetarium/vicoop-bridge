import { OPENAI_COMPAT_EXTENSION_URI } from '@vicoop-bridge/protocol';

export interface TerminalError {
  code: string;
  message: string;
}

export function terminalErrorMetadata(error: TerminalError): Record<string, unknown> {
  const terminalError = {
    code: error.code,
    message: error.message,
  };
  return {
    [OPENAI_COMPAT_EXTENSION_URI]: {
      terminal_error: terminalError,
    },
    // Transitional fallback for gateways that have not migrated to the
    // openai-compat/v1 namespaced terminal_error payload yet.
    error: terminalError,
  };
}

export function terminalErrorExtensions(): string[] {
  return [OPENAI_COMPAT_EXTENSION_URI];
}

export function hasOpenAICompatExtension(extensions: readonly string[] | undefined): boolean {
  return extensions?.includes(OPENAI_COMPAT_EXTENSION_URI) === true;
}

export function terminalErrorMessageFields(
  error: TerminalError,
  requestedExtensions: readonly string[] | undefined,
): { metadata?: Record<string, unknown>; extensions?: string[] } {
  if (!hasOpenAICompatExtension(requestedExtensions)) return {};
  return {
    metadata: terminalErrorMetadata(error),
    extensions: terminalErrorExtensions(),
  };
}
