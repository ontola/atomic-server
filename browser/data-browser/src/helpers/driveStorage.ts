const DriveStorageKEY = 'drive';

export const driveStorage = {
  set(url: string) {
    localStorage.setItem(DriveStorageKEY, JSON.stringify(url));
  },
  get(): string | undefined {
    try {
      const val = localStorage.getItem(DriveStorageKEY);

      return JSON.parse(val as string);
    } catch (e) {
      return undefined;
    }
  },
};
