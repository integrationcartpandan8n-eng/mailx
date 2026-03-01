const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function timestamp(): string {
  return new Date().toISOString();
}

function format(level: string, color: string, context: string, message: string, data?: unknown): string {
  const ts = `${colors.dim}${timestamp()}${colors.reset}`;
  const lvl = `${color}${level.padEnd(5)}${colors.reset}`;
  const ctx = `${colors.cyan}[${context}]${colors.reset}`;
  const base = `${ts} ${lvl} ${ctx} ${message}`;
  if (data !== undefined) {
    return `${base} ${colors.dim}${JSON.stringify(data)}${colors.reset}`;
  }
  return base;
}

export const logger = {
  info(context: string, message: string, data?: unknown) {
    console.log(format('INFO', colors.green, context, message, data));
  },

  warn(context: string, message: string, data?: unknown) {
    console.warn(format('WARN', colors.yellow, context, message, data));
  },

  error(context: string, message: string, data?: unknown) {
    console.error(format('ERROR', colors.red, context, message, data));
  },

  debug(context: string, message: string, data?: unknown) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(format('DEBUG', colors.magenta, context, message, data));
    }
  },
};
