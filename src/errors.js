'use strict';

class ApiError extends Error {
  constructor(status, error, message) {
    super(message);
    this.status = status;
    this.error = error;
  }
}

class ValidationError extends ApiError {
  constructor(message) {
    super(400, 'validation_error', message);
  }
}

class NotFoundError extends ApiError {
  constructor(message) {
    super(404, 'not_found', message);
  }
}

class ConflictError extends ApiError {
  constructor(message) {
    super(409, 'conflict', message);
  }
}

module.exports = { ApiError, ValidationError, NotFoundError, ConflictError };
