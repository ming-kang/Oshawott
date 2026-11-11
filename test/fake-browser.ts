/** The `Browser` members a test's fake broker does not exercise. */
export const unusedTabActions = {
	getTab: async () => null,
	navigateTab: async (): Promise<never> => { throw new Error("unused"); },
	activateTab: async (): Promise<never> => { throw new Error("unused"); },
	closeTab: async () => null,
};
