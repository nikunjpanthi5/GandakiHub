import React from 'react';
import { AppProvider, useApp } from './context/AppContext.tsx';
import { AppShell } from './components/layout/AppShell.tsx';
import { AuthModal } from './components/auth/AuthModal.tsx';
import { PolicyModal } from './components/layout/PolicyModal.tsx';
import { PostFeed } from './components/posts/PostFeed.tsx';
import { AcademicExplorer } from './components/academic/AcademicExplorer.tsx';
import { SearchExplorePage } from './components/search/SearchExplorePage.tsx';
import { TrendingPage } from './components/trending/TrendingPage.tsx';
import { CommunitiesView } from './components/community/CommunitiesDirectory.tsx';
import {
  ComplaintsView,
  ConfessionsView,
  DonationsView,
  EventsView,
  IdeasView,
  OpportunitiesView,
  StudyGroupsView,
} from './components/special/SpecialChannels.tsx';
import {
  ConnectionsView,
  MessagesView,
  NotificationsView,
  ProfileView,
} from './components/social/SocialViews.tsx';
import { AdminDashboard } from './components/admin/AdminDashboard.tsx';

function MainRouter() {
  const { route } = useApp();

  switch (route.page) {
    case 'home':
      return <PostFeed showWelcomeBanner />;
    case 'explore':
      return <SearchExplorePage />;
    case 'academic':
      return <AcademicExplorer />;
    case 'communities':
      return <CommunitiesView />;
    case 'trending':
      return <TrendingPage />;
    case 'opportunities':
      return <OpportunitiesView />;
    case 'events':
      return <EventsView />;
    case 'study-groups':
      return <StudyGroupsView />;
    case 'confessions':
      return <ConfessionsView />;
    case 'complaints':
      return <ComplaintsView />;
    case 'ideas':
      return <IdeasView />;
    case 'donations':
      return <DonationsView />;
    case 'connections':
      return <ConnectionsView />;
    case 'messages':
      return <MessagesView />;
    case 'notifications':
      return <NotificationsView />;
    case 'profile':
      return <ProfileView username={route.param} />;
    case 'admin':
      return <AdminDashboard />;
    default:
      return <PostFeed showWelcomeBanner />;
  }
}

export default function App() {
  return (
    <AppProvider>
      <AppShell>
        <MainRouter />
      </AppShell>
      <AuthModal />
      <PolicyModal />
    </AppProvider>
  );
}
