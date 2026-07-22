import { PUBLIC_WEBSITE_RESOURCE } from '$env/static/public';

export const appState = $state({
	currentSubject: PUBLIC_WEBSITE_RESOURCE,
	// Language of the current page. Set by the page components, empty until then.
	currentLang: ''
});
