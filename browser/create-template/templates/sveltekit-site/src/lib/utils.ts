export function generateId(): string {
	return (Math.random().toString(36) + '00000000000000000').slice(2, 10);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const throttle = <Func extends (...args: any[]) => void | Promise<void>>(
	fn: Func,
	wait: number
) => {
	let prevTime = 0;
	return (...args: Parameters<Func>) => {
		const currentTime = Date.now();
		if (currentTime - prevTime > wait) {
			prevTime = currentTime;
			return fn.apply(this, args);
		}
	};
};
