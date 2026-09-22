'use strict';

const { ValidationError } = require('./errors');

// 接口约定：交换时间一律使用带偏移量的 ISO 8601；库内归一化为 UTC（Z）便于按字符串比较
const OFFSET_RE = /(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeInstant(value, field = '时间') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field}必须是 ISO 8601 字符串`);
  }
  if (!OFFSET_RE.test(value)) {
    throw new ValidationError(`${field}必须带时区偏移量（如 2026-09-22T08:00:00+08:00）`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`${field}无法解析：${value}`);
  }
  return date.toISOString();
}

// 内部历史复原允许只给日期，按该日 23:59:59.999Z 复原“当日结束时”的展陈状态
function resolveAt(value) {
  if (value === undefined || value === null || value === '') {
    return new Date().toISOString();
  }
  if (typeof value === 'string' && DATE_RE.test(value)) {
    const date = new Date(`${value}T23:59:59.999Z`);
    if (Number.isNaN(date.getTime())) {
      throw new ValidationError(`日期无法解析：${value}`);
    }
    return date.toISOString();
  }
  return normalizeInstant(value, 'at');
}

module.exports = { normalizeInstant, resolveAt };
