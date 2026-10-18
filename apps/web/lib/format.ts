function stamp(value: string): string | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function formatStamp(value: string): string {
  return stamp(value) ?? value;
}

export function formatSeen(value: string | null): string {
  if (value === null || value === '') {
    return 'Not seen';
  }
  return stamp(value) ?? value;
}
