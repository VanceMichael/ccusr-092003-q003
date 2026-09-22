
// 业务时间一律使用带偏移量的 ISO 8601 字符串；内部按绝对时刻（epoch 毫秒）比较。

const OFFSET_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

class InvalidTimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidTimeError";
    this.code = "validation";
  }
}

// 解析并校验一个时刻输入，返回 Date。拒绝“无时区”的朴素时间，避免跨日歧义。
function parseInstant(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new InvalidTimeError("无效时刻");
    }
    return value;
  }
  if (typeof value === "number") {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new InvalidTimeError("无效时刻");
    }
    return date;
  }
  if (typeof value !== "string" || !OFFSET_RE.test(value)) {
    throw new InvalidTimeError("时间必须是带偏移量的 ISO 8601 字符串（如 2026-09-22T09:00:00+08:00）");
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new InvalidTimeError("无效时刻");
  }
  return new Date(ms);
}

function epochMillis(value) {
  return parseInstant(value).getTime();
}

function pad(number) {
  return String(number).padStart(2, "0");
}

// 以指定 UTC 偏移（分钟）格式化时刻；默认 +08:00。
function formatWithOffset(date, offsetMinutes = 8 * 60) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function nowIso(offsetMinutes = 8 * 60) {
  return formatWithOffset(new Date(), offsetMinutes);
}

module.exports = { parseInstant, epochMillis, formatWithOffset, nowIso };
