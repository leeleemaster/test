import { StrictMode, useState } from 'react';
import * as ReactDOM from 'react-dom/client';
import App from './app/app';
import ShapeTester from './app/shape-tester';

type Mode = 'tester' | 'editor3d';

function Root() {
  const [mode, setMode] = useState<Mode>('tester');

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {mode === 'tester' ? <ShapeTester /> : <App />}
      <div
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          display: 'flex',
          gap: 6,
          zIndex: 1000,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <button
          onClick={() => setMode('tester')}
          style={tabStyle(mode === 'tester')}
        >
          도형 테스터
        </button>
        <button
          onClick={() => setMode('editor3d')}
          style={tabStyle(mode === 'editor3d')}
        >
          3D 편집기
        </button>
      </div>
    </div>
  );
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: '7px 14px',
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    background: active ? '#5b8cff' : '#2a3346cc',
    color: '#fff',
    boxShadow: '0 2px 8px #0006',
  };
}

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement,
);

root.render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
