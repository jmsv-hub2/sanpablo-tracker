import React, { Suspense, lazy } from 'react';

// Safety wrapper for the ER3 readiness tab. The tab code (and its generated
// park data) is lazy-loaded, so it is fetched and evaluated only when the tab
// is opened — it costs the rest of the app nothing. Any render error inside it
// (including a failed chunk load) is trapped by the boundary below and shown
// inside the tab area, leaving every other tab fully functional.
const ReadinessTab = lazy(() => import('./ReadinessTab.jsx'));

class ReadinessBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ flex: 1, overflowY: 'auto', background: '#0a0a12', padding: '24px 20px' }}>
          <div style={{ background: '#12121f', border: '1px solid #f8717155', borderRadius: 8, padding: '14px 16px', maxWidth: 560 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: '#f87171', marginBottom: 6 }}>⚠ Readiness tab failed to load</div>
            <div style={{ fontSize: 10, color: '#888', lineHeight: 1.6 }}>
              The rest of the tracker is unaffected — switch to any other tab and keep working.
              <div style={{ fontFamily: 'monospace', color: '#666', marginTop: 6 }}>{String(this.state.error?.message || this.state.error)}</div>
            </div>
            <button onClick={() => this.setState({ error: null })}
              style={{ marginTop: 10, background: '#1a1a2e', border: '1px solid #2d2d4a', color: '#aaa', borderRadius: 4, padding: '4px 12px', cursor: 'pointer', fontSize: 10, fontWeight: 600 }}>
              ↺ Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function ReadinessEntry() {
  return (
    <ReadinessBoundary>
      <Suspense fallback={
        <div style={{ flex: 1, background: '#0a0a12', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontSize: 11 }}>
          ⟳ loading readiness model…
        </div>
      }>
        <ReadinessTab />
      </Suspense>
    </ReadinessBoundary>
  );
}
