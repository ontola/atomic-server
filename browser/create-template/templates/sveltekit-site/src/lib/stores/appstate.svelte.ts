import { PUBLIC_WEBSITE_RESOURCE } from '$env/static/public';

export const appState = $state({
	currentSubject: PUBLIC_WEBSITE_RESOURCE
});

export const setCurrentSubject = (value: string) => {
	appState.currentSubject = value;
};
