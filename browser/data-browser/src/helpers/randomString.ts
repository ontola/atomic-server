export const randomString = (length = 15) => {
  const chars =
    'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';

  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }

  return result;
};

export const generateNonce = (length = 16) => {
  const array = new Uint8Array(length);
  window.crypto.getRandomValues(array);

  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
};

export const randomSubject = (parent: string, prefix?: string) => {
  return `${parent}${prefix ? `/${prefix}/` : ''}${randomString(15)}`;
};
