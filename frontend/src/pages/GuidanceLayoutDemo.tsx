import React, { useMemo, useState } from 'react';
import './GuidanceLayoutDemo.css';

interface Guidance {
  id: number;
  summary: string;
  content: string;
}

const guidanceSamples: Guidance[] = [
  {
    id: 1,
    summary: '[Exploration] Based on your 3 earlier ideas, AI provides 6 ideas for you to consider.',
    content: 'A resilient plan should help residents before, during, and after an extreme-heat day.\n\n- Could libraries, pharmacies, and community groups share a simple check-in role?\n- Consider people who cannot travel easily or do not see online alerts.',
  },
  {
    id: 2,
    summary: '[Synthesis] Based on your 4 earlier ideas, AI provides one big connection idea for you to consider.',
    content: 'Connect the heat alert to a trusted local response, so the resident experiences one joined-up service rather than separate services.\n\n- An alert could trigger neighbourhood check-ins and transport help at the same time.\n- Make one organisation responsible for closing the loop when someone needs support.',
  },
  {
    id: 3,
    summary: '[Exploration] Based on your 5 earlier ideas, AI provides 6 ideas for you to consider.',
    content: 'Design for the hardest hour of the day: when heat, caregiving, mobility, and a missed bus happen together.\n\n- What does a resident do if their usual support person is unavailable?\n- Which partners already meet residents where they are and could extend that service?\n- Could the plan make the next best action obvious without asking people to navigate a long website?',
  },
  {
    id: 4,
    summary: '[Synthesis] Based on your 6 earlier ideas, AI provides one big connection idea for you to consider.',
    content: 'Give residents one dependable hand-off from warning to practical support.\n\n- Name the first point of contact, the partner who acts next, and how the resident knows help is on its way.\n- This can reduce duplicated outreach while making limited resources more useful.',
  },
];

function GuidanceCard({ guidance, isNew = false }: { guidance: Guidance; isNew?: boolean }) {
  return (
    <div className={`guidance-demo-card ${isNew ? 'guidance-demo-flash' : ''}`}>
      <div style={{ color: '#38856b', fontSize: '0.78rem', lineHeight: 1.45 }}>{guidance.summary}</div>
      <div style={{ height: 1, backgroundColor: '#a7f3d0', margin: '0.75rem 0' }} />
      <div className="markdown prose" style={{ color: '#064e3b', fontSize: '0.9375rem', lineHeight: 1.5 }}>
        {guidance.content.split('\n').map((line, index) => (
          line.startsWith('- ') ? <div className="guidance-demo-point" key={`${guidance.id}-${index}`}>{line.slice(2)}</div> : line ? <p key={`${guidance.id}-${index}`}>{line}</p> : null
        ))}
      </div>
    </div>
  );
}

function ChatDemo({ mode, latestGuidance }: { mode: 'inline' | 'panel'; latestGuidance: Guidance }) {
  return (
    <div className="section-chat border border-gray-200 rounded-lg p-4 bg-token-bg-primary guidance-demo-chat">
      <div className="guidance-demo-chat-inner">
        <div className="guidance-demo-notification" role="status">AI guidance will appear in 0s</div>
        <h2 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }} className="text-token-text-primary">LLM Chat Interface</h2>
        <div className="guidance-demo-messages" data-interaction-section="response">
          <div className="guidance-demo-assistant">You have several promising ideas. Which residents might still be hard to reach when the city issues a heat warning?</div>
          <div className="guidance-demo-user">I want neighbourhood partners to identify who needs help, but I am still working out how the support connects.</div>
          {mode === 'inline' && <GuidanceCard guidance={latestGuidance} />}
          {mode === 'panel' && <div className="guidance-demo-panel-message">New guidance has appeared in the panel above your writing section.</div>}
          <div className="guidance-demo-assistant">You can keep building on your proposal when you are ready.</div>
        </div>
        <div className="guidance-demo-composer"><span>Send a message…</span><button type="button" aria-label="Send mock message">↑</button></div>
      </div>
    </div>
  );
}

function TranscriptDemo() {
  return (
    <div className="section-transcript border border-gray-200 rounded-lg p-4 bg-token-bg-primary">
      <div className="guidance-demo-audio-status">
        <span className="guidance-demo-connected-dot" />
        <span style={{ color: '#1e40af', fontSize: '0.75rem', fontWeight: 500 }}>Audio recording active - speak naturally</span>
        <span className="guidance-demo-status-divider">·</span>
        <span className="guidance-demo-connected-dot is-connected" />
        <span style={{ fontSize: '0.75rem', color: '#22c55e' }}>Connected</span>
      </div>
      <div className="guidance-demo-transcript-copy">“The service should not assume every resident can travel to a single cooling centre…”</div>
    </div>
  );
}

function WritingDemo() {
  return (
    <div className="section-writing border border-gray-200 rounded-lg p-4 bg-token-bg-primary">
      <div className="guidance-demo-writing-inner">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
          <div>
            <h2 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.25rem' }} className="text-token-text-primary">Writing &amp; Submission</h2>
            <p style={{ fontSize: '0.875rem', color: '#6b7280', margin: 0 }}>Write design proposal for City Heat Resilience</p>
          </div>
        </div>
        <textarea aria-label="Mock writing section" readOnly value={'Our proposal connects the city heat alert to trusted neighbourhood partners. When a warning is issued, partners can check in with residents who may have trouble travelling or finding information…'} />
        <div style={{ marginTop: '0.75rem', marginBottom: '0.75rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '1rem' }} className="text-token-text-secondary">
          <span>Words: 126</span><span>Characters: 743</span><span style={{ color: '#22c55e' }}>Last saved: 10:42</span>
        </div>
        <button type="button" className="guidance-demo-submit">Submit Final Work</button>
      </div>
    </div>
  );
}

export default function GuidanceLayoutDemo() {
  const [mode, setMode] = useState<'inline' | 'panel'>('panel');
  const [visibleGuidance, setVisibleGuidance] = useState<Guidance[]>(guidanceSamples.slice(0, 2));
  const [newGuidanceId, setNewGuidanceId] = useState<number | null>(null);
  const latestGuidance = useMemo(() => visibleGuidance[visibleGuidance.length - 1], [visibleGuidance]);

  const addGuidance = () => {
    const newest = visibleGuidance[visibleGuidance.length - 1];
    const nextSample = guidanceSamples.find((item) => item.id > newest.id) || guidanceSamples[0];
    const next = nextSample.id > newest.id ? nextSample : { ...nextSample, id: newest.id + 1 };
    setVisibleGuidance((items) => [...items, next].slice(-3));
    setNewGuidanceId(next.id);
    window.setTimeout(() => setNewGuidanceId(null), 2800);
  };

  return (
    <>
      <div className="guidance-demo-controls" aria-label="Demo controls">
        <span>Demo</span>
        <button type="button" className={mode === 'inline' ? 'selected' : ''} onClick={() => setMode('inline')}>Current: in chat</button>
        <button type="button" className={mode === 'panel' ? 'selected' : ''} onClick={() => setMode('panel')}>Proposed: by writing</button>
        <button type="button" onClick={addGuidance}>Simulate new guidance</button>
      </div>
      <main className={`main-grid bg-token-bg-primary text-token-text-primary guidance-demo-root ${mode === 'panel' ? 'guidance-demo-panel-layout' : ''}`}>
        <ChatDemo mode={mode} latestGuidance={latestGuidance} />
        <div className="section-right">
          <TranscriptDemo />
          {mode === 'panel' && (
            <div className="section-guidance border border-gray-200 rounded-lg p-4 bg-token-bg-primary">
              <div className="guidance-demo-guidance-inner">
                <h2 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.75rem' }} className="text-token-text-primary">AI Guidance</h2>
                <div className="guidance-demo-guidance-scroll">
                  {[...visibleGuidance].reverse().map((guidance) => <GuidanceCard key={guidance.id} guidance={guidance} isNew={guidance.id === newGuidanceId} />)}
                </div>
              </div>
            </div>
          )}
          <WritingDemo />
        </div>
      </main>
    </>
  );
}
