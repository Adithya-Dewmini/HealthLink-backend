import morgan from "morgan";

export const requestLogger = morgan(
  ':remote-addr :method :url :status :res[content-length] - :response-time ms'
);
