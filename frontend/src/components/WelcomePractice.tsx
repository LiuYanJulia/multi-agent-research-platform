import React from 'react';

interface WelcomePracticeProps {
  onStart: () => void;
  groupId: string;
}

const WelcomePractice: React.FC<WelcomePracticeProps> = ({ onStart, groupId }) => {
  const hasSecondAi = ['2', '3', '4', '5'].includes(groupId.trim());
  const hasTwoPhases = ['4', '5', 'lowtf_hightm', 'lowtf_lowtm'].includes(groupId.trim().toLowerCase());

  return (
    <div style={{
      minHeight: '100vh',
      height: '100vh',
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'center',
      padding: '2rem',
      overflowY: 'auto',
      boxSizing: 'border-box'
    }} className="bg-token-bg-primary">
      <div style={{
        maxWidth: '42rem',
        width: '100%',
        backgroundColor: 'white',
        borderRadius: '0.5rem',
        boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
        padding: '2.5rem',
        margin: '2rem auto',
        flexShrink: 0
      }}>
        <h1 style={{
          fontSize: '1.875rem',
          fontWeight: '700',
          marginBottom: '1.5rem',
          textAlign: 'center'
        }} className="text-token-text-primary">
          Practice Task
        </h1>

        <div style={{
          fontSize: '1rem',
          lineHeight: '1.75',
          marginBottom: '2rem'
        }} className="text-token-text-secondary">
          <p style={{ marginBottom: '1rem' }}>
            Before starting the main experiment, you will complete a short <strong>{hasTwoPhases ? '3-minute' : '2-minute'} practice task</strong> to help you become familiar with the platform and the process of verbalizing your thoughts.
          </p>

          <div style={{
            backgroundColor: '#f3f4f6',
            padding: '1.5rem',
            borderRadius: '0.5rem',
            marginBottom: '1.5rem'
          }}>
            <h2 style={{
              fontSize: '1.125rem',
              fontWeight: '600',
              marginBottom: '1rem'
            }} className="text-token-text-primary">
              Practice Task: Design a Toy
            </h2>
            <p style={{ marginBottom: '0.75rem' }}>
              Your practice task is to <strong>design a toy</strong> and <strong>write down your product design proposal in the writing box on the right-hand side of the platform</strong>.
            </p>
            <p style={{ marginBottom: '0.5rem' }}>
              Here are several sample questions to help you think:
            </p>
            <ul style={{
              marginLeft: '1.5rem',
              listStyle: 'disc',
              marginBottom: '1rem'
            }}>
              <li>What kind of toy would you design?</li>
              <li>Who is the target audience?</li>
              <li>What features would it have?</li>
            </ul>
            <p style={{
              fontSize: '0.875rem',
              fontStyle: 'italic',
              color: '#6b7280'
            }}>
              Duration: {hasTwoPhases ? '3 minutes (two 1 minute 30 second phases)' : '2 minutes'}
            </p>
          </div>

          <h3 style={{
            fontSize: '1rem',
            fontWeight: '600',
            marginBottom: '0.75rem'
          }} className="text-token-text-primary">
            What to Expect:
          </h3>
          <ul style={{
            marginLeft: '1.5rem',
            listStyle: 'disc',
            marginBottom: '1.5rem'
          }}>
            <li style={{ marginBottom: '0.5rem' }}>
              <strong>Voice Recording:</strong> Speak your thoughts out loud as you work through the design
            </li>
            <li style={{ marginBottom: '0.5rem' }}>
              <strong>AI Assistant:</strong> You can ask questions or discuss your ideas with the AI chatbot
            </li>
            <li style={{ marginBottom: '0.5rem' }}>
              <strong>Writing Area:</strong> Jot down notes or key ideas in the writing section
            </li>
            <li style={{ marginBottom: '0.5rem' }}>
              <strong>Timer:</strong> A {hasTwoPhases ? '3-minute practice will be shown as two 1 minute 30 second phases' : '2-minute countdown'} will be displayed on the screen
            </li>
          </ul>

          {hasSecondAi && (
            <div style={{
              backgroundColor: '#ecfdf5',
              padding: '1rem',
              borderRadius: '0.375rem',
              borderLeft: '4px solid #10b981',
              marginBottom: '1.5rem'
            }}>
              <p style={{ fontSize: '0.875rem', color: '#065f46' }}>
                <strong>AI guidance may occasionally appear in the chat.</strong> When it does, select Insert to follow the guidance as you continue the discussion.
              </p>
            </div>
          )}

          {hasTwoPhases && (
            <div style={{
              backgroundColor: '#fefce8',
              padding: '1rem',
              borderRadius: '0.375rem',
              borderLeft: '4px solid #f59e0b',
              marginBottom: '1.5rem'
            }}>
              <p style={{ fontSize: '0.875rem', color: '#78350f', marginBottom: '0.5rem' }}>
                <strong>This practice task has two phases.</strong>
              </p>
              <ol style={{ fontSize: '0.875rem', color: '#78350f', margin: 0, paddingLeft: '1.25rem' }}>
                <li style={{ marginBottom: '0.375rem' }}><strong>Exploration (1 minute 30 seconds):</strong> use the chat to explore ideas. The writing area is locked.</li>
                <li style={{ marginBottom: '0.375rem' }}><strong>Transition:</strong> when exploration ends, a popup pauses the timer. Select Next to begin the next phase.</li>
                <li><strong>Writing (1 minute 30 seconds):</strong> write your proposal. You can no longer send prompts or request AI responses, but AI guidance may still appear.</li>
              </ol>
            </div>
          )}

          <div style={{
            backgroundColor: '#dbeafe',
            padding: '1rem',
            borderRadius: '0.375rem',
            borderLeft: '4px solid #3b82f6'
          }}>
            <p style={{
              fontSize: '0.875rem',
              color: '#1e40af'
            }}>
              <strong>Note:</strong> This is just practice! Your data will not be recorded during this task. Relax and get comfortable with the platform.
            </p>
          </div>
        </div>

        <button
          onClick={onStart}
          style={{
            width: '100%',
            padding: '0.875rem 1.5rem',
            backgroundColor: '#3b82f6',
            color: 'white',
            border: 'none',
            borderRadius: '0.5rem',
            fontSize: '1rem',
            fontWeight: '600',
            cursor: 'pointer',
            transition: 'background-color 0.2s'
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#2563eb'}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#3b82f6'}
        >
          Start the Practice Task
        </button>
      </div>
    </div>
  );
};

export default WelcomePractice;
