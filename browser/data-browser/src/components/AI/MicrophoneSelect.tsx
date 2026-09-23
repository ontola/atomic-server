import { useEffect, useState } from 'react';
import { BasicSelect } from '@components/forms/BasicSelect';
import { useAISettings } from './AISettingsContext';

/**
 * Picks the microphone used for voice input. Browsers hide device names until
 * the page has been granted microphone access, so until then the list shows
 * numbered inputs and an option to ask for access.
 */
export function MicrophoneSelect({ id }: { id?: string }) {
  const { microphoneId, setMicrophoneId } = useAISettings();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices as MediaDevices | undefined;
    if (!mediaDevices?.enumerateDevices) return;

    const refresh = () => void listMicrophones().then(setDevices);
    refresh();
    mediaDevices.addEventListener('devicechange', refresh);

    return () => mediaDevices.removeEventListener('devicechange', refresh);
  }, []);

  if (!navigator.mediaDevices?.getUserMedia) return null;

  const hasLabels = devices.some(device => device.label);
  const selectedMissing =
    microphoneId && !devices.some(device => device.deviceId === microphoneId);

  return (
    <BasicSelect
      id={id}
      aria-label='Microphone'
      value={microphoneId}
      onChange={event => {
        if (event.target.value === 'request-access') {
          void requestMicrophoneAccess().then(listMicrophones).then(setDevices);

          return;
        }

        setMicrophoneId(event.target.value);
      }}
    >
      <option value=''>System default</option>
      {devices.map((device, index) => (
        <option key={device.deviceId} value={device.deviceId}>
          {device.label || `Microphone ${index + 1}`}
        </option>
      ))}
      {selectedMissing && (
        <option value={microphoneId}>Saved microphone</option>
      )}
      {!hasLabels && (
        <option value='request-access'>Show microphone names…</option>
      )}
    </BasicSelect>
  );
}

async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();

    return devices.filter(
      device =>
        device.kind === 'audioinput' &&
        // Empty until the page may use the microphone.
        device.deviceId &&
        // Chrome lists the default and communications devices as aliases.
        device.deviceId !== 'default' &&
        device.deviceId !== 'communications',
    );
  } catch {
    return [];
  }
}

async function requestMicrophoneAccess() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
  } catch {
    // Denied: the list keeps its generic names.
  }
}
