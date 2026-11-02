/** Minutes as "2 h 15 min". */
export const hoursLabel = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
};

/** A running clock: minutes since it started. */
export const minutesSince = (startedAt: string, now = Date.now()) => Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 60_000));
