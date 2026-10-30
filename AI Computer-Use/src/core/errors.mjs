export class ToolError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export class ApprovalRequiredError extends ToolError {
  constructor(request) {
    super('APPROVAL_REQUIRED', `Approval required: ${request.summary}`, { approval: request });
    this.name = 'ApprovalRequiredError';
    this.request = request;
  }
}

export class CancelledError extends ToolError {
  constructor(message = 'Task cancelled by user') {
    super('CANCELLED', message);
    this.name = 'CancelledError';
  }
}

export class BudgetError extends ToolError {
  constructor(code, message) {
    super(code, message);
    this.name = 'BudgetError';
  }
}

export function errorEnvelope(err) {
  if (err instanceof ApprovalRequiredError) {
    return {
      ok: false,
      error: { code: err.code, message: err.message },
      approval_required: err.request,
    };
  }
  return {
    ok: false,
    error: {
      code: err.code ?? 'INTERNAL',
      message: err.message ?? String(err),
      details: err.details,
    },
  };
}
