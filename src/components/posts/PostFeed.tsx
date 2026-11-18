import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowBigDown,
  ArrowBigUp,
  Bookmark,
  Flag,
  MessageSquare,
  Pin,
  Plus,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext.tsx';
import { api, formatRelativeDate, formatRoleLabel } from '../../lib/api.ts';
import type { CommentItem, Community, Post } from '../../types/index.ts';
import { ImageAttachmentField } from '../common/ImageAttachmentField.tsx';

function CommentNode({
  comment,
  depth,
  onReply,
  onVote,
}: {
  comment: CommentItem;
  depth: number;
  onReply: (parentId: string, body: string) => Promise<void>;
  onVote: (commentId: string, val: 1 | -1) => Promise<void>;
}) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [busy, setBusy] = useState(false);

  async function submitReply(e: React.FormEvent) {
    e.preventDefault();
    if (!replyText.trim()) return;
    setBusy(true);
    try {
      await onReply(comment.id, replyText);
      setReplyText('');
      setReplyOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={depth > 0 ? 'ml-5 pl-3 border-l border-slate-200 dark:border-slate-800 space-y-2' : 'space-y-2'}>
      <div className="py-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span className="font-medium text-slate-900 dark:text-slate-100">{comment.author_name}</span>
          <span>·</span>
          <span>{formatRoleLabel(comment.author_role)}</span>
          <span>·</span>
          <span className="font-mono">{formatRelativeDate(comment.created_at)}</span>
        </div>
        <p className="text-sm text-slate-800 dark:text-slate-200 mt-1 whitespace-pre-wrap">{comment.body}</p>
        <div className="flex items-center gap-3 mt-1.5 text-xs text-slate-500 dark:text-slate-400">
          <button
            type="button"
            onClick={() => void onVote(comment.id, 1)}
            className={`inline-flex items-center gap-1 hover:text-blue-700 dark:hover:text-blue-400 ${
              comment.user_vote === 1 ? 'text-blue-700 dark:text-blue-400 font-semibold' : ''
            }`}
          >
            <ArrowBigUp className="w-3.5 h-3.5" />
            <span className="font-mono tabular-nums">{comment.upvote_count - comment.downvote_count}</span>
          </button>
          <button
            type="button"
            onClick={() => setReplyOpen((o) => !o)}
            className="hover:text-slate-900 dark:hover:text-slate-100"
          >
            Reply
          </button>
        </div>

        {replyOpen && (
          <form onSubmit={submitReply} className="mt-2 flex gap-2">
            <input
              type="text"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Write a reply..."
              className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs"
            />
            <button
              type="submit"
              disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium"
            >
              Send
            </button>
          </form>
        )}
      </div>

      {comment.replies?.map((child) => (
        <CommentNode key={child.id} comment={child} depth={depth + 1} onReply={onReply} onVote={onVote} />
      ))}
    </div>
  );
}

export function PostFeed({
  communitySlug,
  showWelcomeBanner = false,
}: {
  communitySlug?: string;
  showWelcomeBanner?: boolean;
}) {
  const { user, communities, structure, navigate, setAuthModalOpen, refreshCommunities, notify } = useApp();
  const [sort, setSort] = useState<'for_you' | 'latest' | 'trending' | 'top'>('latest');
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedPostId, setExpandedPostId] = useState<string | null>(null);
  const [commentsByPost, setCommentsByPost] = useState<Record<string, CommentItem[]>>({});
  const [newCommentText, setNewCommentText] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [reportTarget, setReportTarget] = useState<{ type: 'post'; id: string } | null>(null);
  const [reportReason, setReportReason] = useState('Harassment or abusive behavior');

  // Create Post form state
  const [postCommunityId, setPostCommunityId] = useState('');
  const [postTitle, setPostTitle] = useState('');
  const [postBody, setPostBody] = useState('');
  const [postImageUrl, setPostImageUrl] = useState<string | null>(null);
  const [postFlair, setPostFlair] = useState('');
  const [postTagsRaw, setPostTagsRaw] = useState('');
  const [postProgId, setPostProgId] = useState('');
  const [includePoll, setIncludePoll] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState(['', '']);

  const activeCommunity: Community | undefined = communitySlug
    ? communities.find((c) => c.slug === communitySlug)
    : undefined;

  const loadPosts = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ sort });
      if (communitySlug) qs.set('community_slug', communitySlug);
      const data = await api.get<{ posts: Post[] }>(`/api/posts?${qs.toString()}`);
      setPosts(data.posts);
    } catch {
      setPosts([]);
    } finally {
      setLoading(false);
    }
  }, [sort, communitySlug]);

  useEffect(() => {
    void loadPosts();
  }, [loadPosts]);

  useEffect(() => {
    if (activeCommunity) {
      setPostCommunityId(activeCommunity.id);
    } else if (communities.length > 0 && !postCommunityId) {
      const defaultComm = communities.find((c) => c.slug === 'random') || communities[0];
      if (defaultComm) setPostCommunityId(defaultComm.id);
    }
  }, [activeCommunity, communities, postCommunityId]);

  async function loadComments(postId: string) {
    const data = await api.get<{ comments: CommentItem[] }>(`/api/posts/${postId}/comments`);
    setCommentsByPost((prev) => ({ ...prev, [postId]: data.comments }));
  }

  async function toggleComments(postId: string) {
    if (expandedPostId === postId) {
      setExpandedPostId(null);
      return;
    }
    setExpandedPostId(postId);
    await loadComments(postId);
  }

  async function handleVote(targetType: 'post' | 'comment', targetId: string, value: 1 | -1) {
    if (!user) {
      setAuthModalOpen(true);
      return;
    }
    try {
      await api.post('/api/votes', { target_type: targetType, target_id: targetId, value });
      if (targetType === 'post') await loadPosts();
      else if (expandedPostId) await loadComments(expandedPostId);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to vote', 'error');
    }
  }

  async function handleBookmark(postId: string) {
    if (!user) {
      setAuthModalOpen(true);
      return;
    }
    const res = await api.post<{ bookmarked: boolean }>('/api/bookmarks/toggle', { target_type: 'post', target_id: postId });
    setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, is_bookmarked: res.bookmarked } : p)));
    notify(res.bookmarked ? 'Saved to your bookmarks.' : 'Removed from bookmarks.', 'info');
  }

  async function handlePollVote(pollId: string, optionId: string) {
    if (!user) {
      setAuthModalOpen(true);
      return;
    }
    try {
      await api.post(`/api/polls/${pollId}/vote`, { option_id: optionId });
      await loadPosts();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Poll vote failed.', 'error');
    }
  }

  async function handleCreatePost(e: React.FormEvent) {
    e.preventDefault();
    if (!postTitle.trim() && !postBody.trim() && !postImageUrl) {
      notify('Please write a title or text, attach an image, or include both.', 'error');
      return;
    }
    try {
      const tags = postTagsRaw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 5);

      const cleanPollOpts = pollOptions.map((o) => o.trim()).filter(Boolean);
      await api.post('/api/posts', {
        community_id: postCommunityId,
        title: postTitle,
        body: postBody,
        image_url: postImageUrl,
        flair: postFlair || null,
        tags,
        program_id: postProgId || null,
        poll: includePoll && pollQuestion.trim() && cleanPollOpts.length >= 2
          ? { question: pollQuestion.trim(), options: cleanPollOpts }
          : null,
      });

      setCreateOpen(false);
      setPostTitle('');
      setPostBody('');
      setPostImageUrl(null);
      setPostFlair('');
      setPostTagsRaw('');
      setIncludePoll(false);
      setPollQuestion('');
      setPollOptions(['', '']);
      await loadPosts();
      notify('Discussion post published.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to create post.', 'error');
    }
  }

  async function handleAddComment(postId: string, parentId: string | null, body: string) {
    if (!user) {
      setAuthModalOpen(true);
      return;
    }
    try {
      await api.post(`/api/posts/${postId}/comments`, { body, parent_comment_id: parentId });
      await loadComments(postId);
      await loadPosts();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not post comment.', 'error');
    }
  }

  async function handlePin(post: Post) {
    await api.patch(`/api/posts/${post.id}`, { is_pinned: !post.is_pinned });
    await loadPosts();
    notify(post.is_pinned ? 'Post unpinned.' : 'Post pinned to community.', 'info');
  }

  async function handleDelete(postId: string) {
    await api.delete(`/api/posts/${postId}`);
    await loadPosts();
    notify('Post deleted.', 'info');
  }

  async function handleJoinCommunity(commId: string) {
    if (!user) {
      setAuthModalOpen(true);
      return;
    }
    try {
      const res = await api.post<{ joined: boolean; status: string }>(`/api/communities/${commId}/join`);
      await refreshCommunities();
      notify(res.joined ? 'Joined community.' : 'Left community.', 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Membership action failed.', 'error');
    }
  }

  async function submitReport(e: React.FormEvent) {
    e.preventDefault();
    if (!reportTarget) return;
    await api.post('/api/reports', {
      target_type: reportTarget.type,
      target_id: reportTarget.id,
      reason: reportReason,
    });
    setReportTarget(null);
    notify('Report submitted to moderators.', 'success');
  }

  return (
    <div className="space-y-5">
      {showWelcomeBanner && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-blue-700 dark:text-blue-400">
                Your University. Your Community. Your Knowledge.
              </p>
              <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white text-balance">
                GandakiHub Campus Commons
              </h1>
              <p className="text-sm text-slate-600 dark:text-slate-300 max-w-2xl">
                Browse semester-organized PDF notes, past questions, academic discussions, student opportunities, and campus channels built for Gandaki University learners.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => navigate('academic')}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                Browse Notes & PDFs
              </button>
              <button
                type="button"
                onClick={() => (user ? setCreateOpen(true) : setAuthModalOpen(true))}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium hover:bg-slate-800 dark:hover:bg-blue-500 whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                Create Post
              </button>
            </div>
          </div>
        </section>
      )}

      {activeCommunity && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
            <div>
              <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white">{activeCommunity.name}</h1>
              <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">{activeCommunity.description}</p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mt-2 font-mono tabular-nums">
                <span>{activeCommunity.member_count} members</span>
                <span>·</span>
                <span>{activeCommunity.visibility.replace('_', ' ')}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void handleJoinCommunity(activeCommunity.id)}
                className={`px-3.5 py-2 rounded-lg text-xs font-medium whitespace-nowrap ${
                  activeCommunity.is_member
                    ? 'border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                    : 'bg-slate-900 dark:bg-blue-600 text-white'
                }`}
              >
                {activeCommunity.is_member ? 'Joined' : 'Join Community'}
              </button>
              <button
                type="button"
                onClick={() => (user ? setCreateOpen(true) : setAuthModalOpen(true))}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                New Post
              </button>
            </div>
          </div>
          {activeCommunity.rules && (
            <p className="text-xs text-slate-500 dark:text-slate-400 pt-2 border-t border-slate-100 dark:border-slate-800">
              Rules: {activeCommunity.rules}
            </p>
          )}
        </section>
      )}

      {/* Feed Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800/80">
          {([
            { id: 'for_you', label: 'For You' },
            { id: 'latest', label: 'Latest' },
            { id: 'trending', label: 'Trending' },
            { id: 'top', label: 'Most Upvoted' },
          ] as const).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSort(tab.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                sort === tab.id
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {!showWelcomeBanner && !activeCommunity && (
          <button
            type="button"
            onClick={() => (user ? setCreateOpen(true) : setAuthModalOpen(true))}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            Create Post
          </button>
        )}
      </div>

      {/* Posts List */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-36 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 animate-pulse" />
          ))}
        </div>
      ) : posts.length === 0 ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center space-y-2">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">No discussions in this view yet</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Start a constructive discussion, question, or poll for your peers.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {posts.map((post) => {
            const isOwner = user?.id === post.author_id;
            const canMod =
              user &&
              (['super_admin', 'admin'].includes(user.role) || user.moderated_community_ids.includes(post.community_id));
            return (
              <article
                key={post.id}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3"
              >
                {/* Clean Zero-Pill Metadata Line */}
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => navigate('communities', post.community_slug)}
                      className="font-semibold text-slate-800 dark:text-slate-200 hover:underline"
                    >
                      {post.community_name}
                    </button>
                    <span>·</span>
                    <button
                      type="button"
                      onClick={() => navigate('profile', post.author_username)}
                      className="hover:underline"
                    >
                      {post.author_name}
                    </button>
                    <span>·</span>
                    <span>{formatRoleLabel(post.author_role)}</span>
                    {post.flair && (
                      <>
                        <span>·</span>
                        <span className="text-blue-700 dark:text-blue-400 font-medium">{post.flair}</span>
                      </>
                    )}
                    {post.is_pinned && (
                      <>
                        <span>·</span>
                        <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400">
                          <Pin className="w-3 h-3" /> Pinned
                        </span>
                      </>
                    )}
                    <span>·</span>
                    <span className="font-mono">{formatRelativeDate(post.created_at)}</span>
                  </div>
                </div>

                <div className="space-y-2">
                  {post.title && (
                    <h2 className="font-display text-base sm:text-lg font-semibold text-slate-900 dark:text-white leading-snug">
                      {post.title}
                    </h2>
                  )}
                  {post.body && (
                    <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed">
                      {post.body}
                    </p>
                  )}
                  {post.image_url && (
                    <img
                      src={post.image_url}
                      alt={post.title || 'Discussion image attachment'}
                      className="max-h-[420px] w-auto rounded-lg border border-slate-200 dark:border-slate-800 object-contain bg-slate-50 dark:bg-slate-950"
                    />
                  )}
                </div>

                {post.tags.length > 0 && (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Topics: {post.tags.join(' · ')}
                  </div>
                )}

                {/* Interactive Poll */}
                {post.poll && (
                  <div className="pt-2 space-y-2 border-t border-slate-100 dark:border-slate-800">
                    <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                      Poll: {post.poll.question}
                    </div>
                    <div className="space-y-1.5">
                      {post.poll.options.map((opt) => {
                        const selected = post.poll?.user_option_id === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => void handlePollVote(post.poll!.id, opt.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg border text-xs transition-colors flex items-center justify-between gap-2 ${
                              selected
                                ? 'border-blue-600 bg-blue-50/70 dark:bg-blue-950/40 text-slate-900 dark:text-white font-medium'
                                : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                            }`}
                          >
                            <span>{opt.label}</span>
                            <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
                              {opt.percentage}% ({opt.vote_count})
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="text-[11px] font-mono tabular-nums text-slate-400">
                      {post.poll.total_votes} total votes
                    </div>
                  </div>
                )}

                {/* Action Bar */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400">
                  <div className="flex items-center gap-3">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void handleVote('post', post.id, 1)}
                        className={`p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 ${
                          post.user_vote === 1 ? 'text-blue-700 dark:text-blue-400' : ''
                        }`}
                        aria-label="Upvote post"
                      >
                        <ArrowBigUp className="w-4 h-4" />
                      </button>
                      <span className="font-mono tabular-nums font-semibold text-slate-800 dark:text-slate-200">
                        {post.score}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleVote('post', post.id, -1)}
                        className={`p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 ${
                          post.user_vote === -1 ? 'text-red-600 dark:text-red-400' : ''
                        }`}
                        aria-label="Downvote post"
                      >
                        <ArrowBigDown className="w-4 h-4" />
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => void toggleComments(post.id)}
                      className="inline-flex items-center gap-1.5 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <MessageSquare className="w-3.5 h-3.5" />
                      <span className="font-mono tabular-nums">{post.comment_count} Comments</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleBookmark(post.id)}
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 ${
                        post.is_bookmarked ? 'text-blue-700 dark:text-blue-400 font-medium' : ''
                      }`}
                    >
                      <Bookmark className="w-3.5 h-3.5" />
                      <span>{post.is_bookmarked ? 'Saved' : 'Save'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(`${window.location.origin}/#/communities/${post.community_slug}`);
                        notify('Community link copied to clipboard.', 'info');
                      }}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <Share2 className="w-3.5 h-3.5" />
                      <span>Share</span>
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    {canMod && (
                      <button
                        type="button"
                        onClick={() => void handlePin(post)}
                        className="px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        {post.is_pinned ? 'Unpin' : 'Pin'}
                      </button>
                    )}
                    {(isOwner || canMod) && (
                      <button
                        type="button"
                        onClick={() => void handleDelete(post.id)}
                        className="p-1.5 rounded text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                        aria-label="Delete post"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => (user ? setReportTarget({ type: 'post', id: post.id }) : setAuthModalOpen(true))}
                      className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                      aria-label="Report post"
                    >
                      <Flag className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Expanded Nested Comment Thread */}
                {expandedPostId === post.id && (
                  <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!newCommentText.trim()) return;
                        void handleAddComment(post.id, null, newCommentText);
                        setNewCommentText('');
                      }}
                      className="flex gap-2"
                    >
                      <input
                        type="text"
                        value={newCommentText}
                        onChange={(e) => setNewCommentText(e.target.value)}
                        placeholder={user ? 'Add a comment to this discussion...' : 'Sign in to comment'}
                        className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs"
                      />
                      <button
                        type="submit"
                        className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium"
                      >
                        Comment
                      </button>
                    </form>

                    {(commentsByPost[post.id] || []).length === 0 ? (
                      <p className="text-xs text-slate-500">No comments yet.</p>
                    ) : (
                      <div className="divide-y divide-slate-100 dark:divide-slate-800">
                        {(commentsByPost[post.id] || []).map((cmt) => (
                          <CommentNode
                            key={cmt.id}
                            comment={cmt}
                            depth={0}
                            onReply={(parentId, body) => handleAddComment(post.id, parentId, body)}
                            onVote={(cid, val) => handleVote('comment', cid, val)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {/* Create Post Modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="text-base font-semibold text-slate-900 dark:text-white">Create Discussion Post</h3>
              <button type="button" onClick={() => setCreateOpen(false)} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreatePost} className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Community</label>
                  <select
                    required
                    value={postCommunityId}
                    onChange={(e) => setPostCommunityId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                  >
                    {communities
                      .filter((c) => c.slug !== 'confessions' && c.slug !== 'complaints-suggestions')
                      .map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Related Program (Optional)</label>
                  <select
                    value={postProgId}
                    onChange={(e) => setPostProgId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                  >
                    <option value="">General / All Programs</option>
                    {structure.programs.map((p) => (
                      <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Title (Optional if posting image or text)
                </label>
                <input
                  type="text"
                  value={postTitle}
                  onChange={(e) => setPostTitle(e.target.value)}
                  placeholder="Clear, descriptive discussion title"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Content (Optional if attaching an image)
                </label>
                <textarea
                  rows={4}
                  value={postBody}
                  onChange={(e) => setPostBody(e.target.value)}
                  placeholder="Share context, questions, or discussion details..."
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                />
              </div>

              <ImageAttachmentField
                imageUrl={postImageUrl}
                onChange={setPostImageUrl}
                onError={(msg) => notify(msg, 'error')}
              />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Flair (Optional)</label>
                  <input
                    type="text"
                    value={postFlair}
                    onChange={(e) => setPostFlair(e.target.value)}
                    placeholder="e.g. Question, Study Guide"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Tags (comma separated)</label>
                  <input
                    type="text"
                    value={postTagsRaw}
                    onChange={(e) => setPostTagsRaw(e.target.value)}
                    placeholder="BIT, Midterm, Lab"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-3">
                <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={includePoll}
                    onChange={(e) => setIncludePoll(e.target.checked)}
                  />
                  Attach a community poll
                </label>

                {includePoll && (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={pollQuestion}
                      onChange={(e) => setPollQuestion(e.target.value)}
                      placeholder="Poll question"
                      className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                    />
                    {pollOptions.map((opt, idx) => (
                      <input
                        key={idx}
                        type="text"
                        value={opt}
                        onChange={(e) => {
                          const next = [...pollOptions];
                          next[idx] = e.target.value;
                          setPollOptions(next);
                        }}
                        placeholder={`Option ${idx + 1}`}
                        className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs"
                      />
                    ))}
                    {pollOptions.length < 5 && (
                      <button
                        type="button"
                        onClick={() => setPollOptions([...pollOptions, ''])}
                        className="text-xs text-blue-700 dark:text-blue-400 font-medium"
                      >
                        + Add Poll Option
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium"
                >
                  Publish Post
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Report Modal */}
      {reportTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <form onSubmit={submitReport} className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
            <h3 className="text-base font-semibold">Report Content</h3>
            <select
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value)}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
            >
              <option>Harassment or abusive behavior</option>
              <option>Spam or misleading content</option>
              <option>Wrong academic category or subject</option>
              <option>Privacy violation or personal info exposure</option>
            </select>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setReportTarget(null)} className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs">
                Cancel
              </button>
              <button type="submit" className="px-4 py-1.5 rounded-lg bg-red-600 text-white text-xs font-medium">
                Submit Report
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
