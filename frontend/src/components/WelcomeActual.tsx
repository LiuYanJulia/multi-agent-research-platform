import React from 'react';

interface WelcomeActualProps {
  onStart: () => void;
  groupId: string;
}

const WelcomeActual: React.FC<WelcomeActualProps> = ({ onStart, groupId }) => {
  const hasSecondAi = ['2', '3', '4', '5'].includes(groupId.trim());
  const hasTwoPhases = ['4', '5', 'lowtf_hightm', 'lowtf_lowtm'].includes(groupId.trim().toLowerCase());
  const hasOptionalWrapUp = hasSecondAi;

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
          Main Design Task
        </h1>

        <div style={{
          fontSize: '1rem',
          lineHeight: '1.75',
          marginBottom: '2rem'
        }} className="text-token-text-secondary">
          <p style={{ marginBottom: '1rem' }}>
            You will now begin the main experiment. Please take your time and engage thoughtfully with the task.
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
              Your Task: Brainstorm New Ideas for a Career-Development Website
            </h2>
            <p style={{ marginBottom: '0.75rem' }}>
              Please brainstorm new ideas for a career-development website and write a proposal presenting your ideas.
            </p>
            <p style={{ marginBottom: '0.75rem' }}>
              Many existing career-development websites offer familiar services, such as CV refinement and mock interviews. Your goal is to propose features, formats, or pipelines that could make a career-development website meaningfully different from what is already available.
            </p>
            <p style={{ marginBottom: '0.75rem' }}>
              Your proposal should introduce your ideas and explain how they would work. It will be evaluated on two criteria:
            </p>
            <ul style={{ margin: '0 0 0.75rem', paddingLeft: '1.5rem' }}>
              <li><strong>Creativity:</strong> How original, distinctive, and imaginative are the ideas?</li>
              <li><strong>Usefulness:</strong> How well could the ideas help users with their career development?</li>
            </ul>
            <p style={{ marginBottom: 0 }}>
              You may focus on new website features, end-to-end user journeys, interaction formats, or service pipelines. The final output should be a <strong>proposal for new ideas for a career-development website</strong>, clearly presenting the ideas and their potential value.
            </p>
          </div>

          <div style={{
            backgroundColor: '#fef3c7',
            padding: '1.25rem',
            borderRadius: '0.5rem',
            marginBottom: '1.5rem',
            border: '1px solid #fbbf24'
          }}>
            <p style={{
              fontSize: '1rem',
              fontWeight: '600',
              marginBottom: '0.5rem',
              color: '#92400e'
            }}>
              ⚠️ Important Reminder:
            </p>
            <p style={{ color: '#92400e' }}>
              Do not focus on technical details. Rather than a programmer or software engineer, please treat yourself as a <strong>product manager</strong>, to brainstorm creative and useful new ideas or features for the website, focusing on user needs, features, and experiences rather than implementation details.
            </p>
          </div>

          <h3 style={{
            fontSize: '1rem',
            fontWeight: '600',
            marginBottom: '0.75rem'
          }} className="text-token-text-primary">
            Requirements:
          </h3>
          <ul style={{
            marginLeft: '1.5rem',
            listStyle: 'disc',
            marginBottom: '1.5rem'
          }}>
            <li style={{ marginBottom: '0.5rem' }}>
              <strong>Minimum Time:</strong> Please spend at least 10 minutes on this task
            </li>
            <li style={{ marginBottom: '0.5rem' }}>
              <strong>Maximum Time:</strong> {hasOptionalWrapUp ? '27 minutes, including an optional two-minute wrap-up after 25 minutes' : '25 minutes'}
            </li>
            <li style={{ marginBottom: '0.5rem' }}>
              <strong>Verbalize Your Thoughts:</strong> Continue speaking out loud as you work
            </li>
            <li style={{ marginBottom: '0.5rem' }}>
              <strong>AI Assistant:</strong> You can discuss your ideas with the AI chatbot. It will respond to the questions you ask.
            </li>
            <li style={{ marginBottom: '0.5rem' }}>
              <strong>Use All Tools:</strong> Feel free to use the AI assistant and writing area, but please remain on this website throughout the entire process until you submit your final work
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
                <strong>AI guidance may occasionally appear automatically in the chat.</strong> It generates guidance based on creativity research theory and may invite you to explore a different direction or combine compatible ideas. A five-second countdown will appear before the guidance and its AI response are added to the conversation.
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
                <strong>This task has two phases.</strong>
              </p>
              <ol style={{ fontSize: '0.875rem', color: '#78350f', margin: 0, paddingLeft: '1.25rem' }}>
                <li style={{ marginBottom: '0.375rem' }}><strong>Exploration:</strong> spend at least 5 minutes, and no more than 19 minutes, using the chat to explore ideas. The writing area is locked during this phase. The Next button becomes available after 5 minutes; move to writing by 19 minutes so you have enough time to complete your written proposal.</li>
                <li><strong>Writing:</strong> after selecting Next, write your response. You can no longer send prompts or request AI responses, but AI guidance may still appear in the chat after its five-second countdown notification.</li>
              </ol>
            </div>
          )}

        </div>

        <button
          onClick={onStart}
          style={{
            width: '100%',
            padding: '0.875rem 1.5rem',
            backgroundColor: '#10b981',
            color: 'white',
            border: 'none',
            borderRadius: '0.5rem',
            fontSize: '1rem',
            fontWeight: '600',
            cursor: 'pointer',
            transition: 'background-color 0.2s'
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#059669'}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#10b981'}
        >
          Start the Main Task
        </button>
      </div>
    </div>
  );
};

export default WelcomeActual;
