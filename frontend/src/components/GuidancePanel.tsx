import React from 'react';
import ReactMarkdown from 'react-markdown';

export interface DisplayedGuidance {
  id: string;
  content: string;
  displaySummary?: string;
  timestamp: Date;
}

interface GuidancePanelProps {
  guidance: DisplayedGuidance[];
  newlyDeliveredId?: string | null;
}

const EMPTY_GUIDANCE_COPY = 'Proactive AI guidance will be shown here. Please consider them into your own thinking';

const GuidancePanel: React.FC<GuidancePanelProps> = ({ guidance, newlyDeliveredId = null }) => {
  const visibleGuidance = guidance.slice(-3);

  return (
    <section aria-label="AI Guidance" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <h2 style={{ fontSize: '1.125rem', fontWeight: 600, margin: '0 0 0.75rem' }} className="text-token-text-primary">AI Guidance</h2>
      <div
        style={{
          flex: '1 1 0', minHeight: 0, overflowY: 'auto', padding: '0.75rem 1rem',
          backgroundColor: 'rgba(236, 253, 245, 0.5)', border: '1px solid #a7f3d0', borderRadius: '0.5rem',
        }}
      >
        {visibleGuidance.length === 0 ? (
          <p style={{ height: '100%', margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', fontSize: '0.875rem', lineHeight: 1.5, textAlign: 'center' }}>
            {EMPTY_GUIDANCE_COPY}
          </p>
        ) : visibleGuidance.map((item) => (
          <article
            key={item.id}
            data-testid={`guidance-card-${item.id}`}
            className={item.id === newlyDeliveredId ? 'guidance-panel-flash-five' : undefined}
            style={{
              marginBottom: '0.75rem', padding: '0.75rem 1rem', backgroundColor: '#ecfdf5',
              border: '1px solid #a7f3d0', borderRadius: '12px',
              animation: item.id === newlyDeliveredId ? 'guidance-panel-attention 0.52s ease-in-out 5' : undefined,
            }}
          >
            {item.displaySummary && <div style={{ color: '#38856b', fontSize: '0.78rem', lineHeight: 1.45 }}>{item.displaySummary}</div>}
            {item.displaySummary && <div style={{ height: 1, backgroundColor: '#a7f3d0', margin: '0.75rem 0' }} />}
            <div className="markdown prose" style={{ color: '#064e3b', fontSize: '0.9375rem', lineHeight: 1.5, overflowX: 'auto' }}>
              <ReactMarkdown>{item.content}</ReactMarkdown>
            </div>
          </article>
        ))}
      </div>
      <style>{`
        @keyframes guidance-panel-attention {
          0%, 100% { background-color: #ecfdf5; border-color: #a7f3d0; }
          50% { background-color: #bbf7d0; border-color: #059669; box-shadow: 0 0 0 3px rgba(5, 150, 105, 0.2); }
        }
      `}</style>
    </section>
  );
};

export default GuidancePanel;
