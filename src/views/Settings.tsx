import { NavLink, useParams } from 'react-router-dom';
import LibrarySettings from './settings/LibrarySettings';
import ScanSettings from './settings/ScanSettings';
import VisualizerSettings from './settings/VisualizerSettings';
import PlaybackSettings from './settings/PlaybackSettings';
import ConversionSettings from './settings/ConversionSettings';
import AboutSettings from './settings/AboutSettings';

const TABS = [
  { id: 'library', label: 'Library' },
  { id: 'scan', label: 'Scanning & Metadata' },
  { id: 'visualizer', label: 'Visualizer' },
  { id: 'playback', label: 'Playback' },
  { id: 'conversion', label: 'Shrink albums' },
  { id: 'about', label: 'About & Updates' },
];

export default function Settings() {
  const { tab } = useParams();
  const active = tab ?? 'library';
  const Component =
    active === 'scan' ? ScanSettings :
    active === 'visualizer' ? VisualizerSettings :
    active === 'playback' ? PlaybackSettings :
    active === 'conversion' ? ConversionSettings :
    active === 'about' ? AboutSettings :
    LibrarySettings;

  return (
    <section className="p-8 max-w-5xl">
      <h1 className="text-3xl font-bold mb-6">Settings</h1>
      <div className="grid grid-cols-[200px_1fr] gap-8">
        <aside className="space-y-1">
          {TABS.map((t) => (
            <NavLink
              key={t.id}
              to={`/settings/${t.id}`}
              className={() =>
                `block px-3 py-2 rounded text-sm ${active === t.id ? 'bg-bg-elev-2 text-white' : 'text-text-secondary hover:text-white'}`
              }
            >{t.label}</NavLink>
          ))}
        </aside>
        <div><Component /></div>
      </div>
    </section>
  );
}
