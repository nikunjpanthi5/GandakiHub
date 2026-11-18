import React from 'react';
import { X } from 'lucide-react';
import { useApp } from '../../context/AppContext.tsx';

export function PolicyModal() {
  const { policyModal, setPolicyModal } = useApp();
  if (!policyModal) return null;

  const titles: Record<NonNullable<typeof policyModal>, string> = {
    privacy: 'Privacy Policy & Anonymity Disclosure',
    terms: 'Terms of Use',
    guidelines: 'Community Guidelines',
    moderation: 'Content Moderation & Academic Integrity Policy',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
      <div className="w-full max-w-2xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{titles[policyModal]}</h2>
          <button
            type="button"
            onClick={() => setPolicyModal(null)}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close policy dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4 text-sm text-slate-700 dark:text-slate-300 max-h-[70vh] overflow-y-auto leading-relaxed">
          {policyModal === 'privacy' && (
            <>
              <p>
                <strong>Independent Platform:</strong> GandakiHub is an independent student-developed community platform and is not officially owned, operated, or endorsed by Gandaki University.
              </p>
              <p>
                <strong>Private Data Protection:</strong> Your email address, connection lists, private complaints, and personal search history are never exposed publicly on your profile or in search results.
              </p>
              <p>
                <strong>Honest Confession Anonymity Notice:</strong> Approved confessions are published without author identity in public tables, API payloads, and search indexes. Author-to-confession mappings are stored in an isolated vault accessible only to the Super Admin under mandatory audit logging for severe safety or legal emergencies. However, technical anonymity cannot be guaranteed against compromised client devices, infrastructure-level interception, legal compulsion, or security breaches.
              </p>
              <p>
                <strong>Private Messaging Status:</strong> Direct messaging is currently in development. GandakiHub does not store plaintext chat messages or claim end-to-end encryption before an audited Matrix/E2EE protocol is deployed.
              </p>
            </>
          )}

          {policyModal === 'terms' && (
            <>
              <p>
                By using GandakiHub, you agree to provide accurate registration details, respect academic integrity, and refrain from attempting unauthorized access to private resources or administrative controls.
              </p>
              <p>
                Uploaded PDF resources remain the intellectual work of their respective authors or public course references. Only upload materials you are permitted to share for academic study.
              </p>
              <p>
                External users (Future Students, Alumni, Visitors) must abide by role-specific community boundaries.
              </p>
            </>
          )}

          {policyModal === 'guidelines' && (
            <>
              <p>
                <strong>1. Respectful Discourse:</strong> Critique ideas, policies, and code constructively—never attack individuals, faculty, or fellow students.
              </p>
              <p>
                <strong>2. Accurate Academic Organization:</strong> Upload PDF notes, past questions, and projects only under the matching program, semester, subject, and category with descriptive titles.
              </p>
              <p>
                <strong>3. Zero Doxxing or Harassment:</strong> Do not publish private phone numbers, bank details, medical records, or personally identifying attacks in Confessions, Complaints, or Donations.
              </p>
            </>
          )}

          {policyModal === 'moderation' && (
            <>
              <p>
                GandakiHub combines multilingual profanity detection (English, Nepali Devanagari, and Romanized Nepali), community reporting, and human moderator review.
              </p>
              <p>
                Academic resources undergo moderator review before initial publication. Edits to already-approved resources create a pending revision while keeping the prior approved version accessible until reviewed.
              </p>
              <p>
                Moderation actions follow graduated enforcement (warning, content removal, account restriction, suspension), and all administrative actions are recorded in tamper-evident audit logs.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
