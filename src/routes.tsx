import { Navigate, type RouteObject } from "react-router-dom";
import AppLayout from "./components/common/AppLayout";

import Dashboard from "./pages/Dashboard";
import Tasks from "./pages/Tasks";
import Routines from "./pages/Routines";
import Focus from "./pages/Focus";
import Cleanup from "./pages/Cleanup";
import Progress from "./pages/Progress";
import Settings from "./pages/Settings";

import TasksToday from "./components/tasks/TasksToday";
import TasksUpcoming from "./components/tasks/TasksUpcoming";
import TasksInbox from "./components/tasks/TasksInbox";
import TasksCompleted from "./components/tasks/TasksCompleted";
import TasksRecurring from "./components/tasks/TasksRecurring";

import MyRoutines from "./components/routines/MyRoutines";
import CreateRoutine from "./components/routines/CreateRoutine";
import RoutineTemplates from "./components/routines/RoutineTemplates";

import FocusTimer from "./components/focus/FocusTimer";
import FocusHistory from "./components/focus/FocusHistory";

import CleanupDownloads from "./components/cleanup/CleanupDownloads";
import CleanupDesktop from "./components/cleanup/CleanupDesktop";
import CleanupDuplicates from "./components/cleanup/CleanupDuplicates";
import CleanupLargeFiles from "./components/cleanup/CleanupLargeFiles";
import CleanupScreenshots from "./components/cleanup/CleanupScreenshots";
import CleanupStorage from "./components/cleanup/CleanupStorage";

import ProgressStatistics from "./components/progress/ProgressStatistics";
import ProgressAchievements from "./components/progress/ProgressAchievements";
import ProgressStreak from "./components/progress/ProgressStreak";

/**
 * Top-level route tree, matching development-plan.md section 64.
 * Section pages (Tasks, Routines, Focus, Cleanup, Progress) act as
 * layouts rendering a sub-nav plus their nested sub-views via <Outlet />.
 */
export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <Dashboard /> },
      {
        path: "tasks",
        element: <Tasks />,
        children: [
          { index: true, element: <Navigate to="today" replace /> },
          { path: "today", element: <TasksToday /> },
          { path: "upcoming", element: <TasksUpcoming /> },
          { path: "inbox", element: <TasksInbox /> },
          { path: "completed", element: <TasksCompleted /> },
          { path: "recurring", element: <TasksRecurring /> },
        ],
      },
      {
        path: "routines",
        element: <Routines />,
        children: [
          { index: true, element: <Navigate to="my-routines" replace /> },
          { path: "my-routines", element: <MyRoutines /> },
          { path: "create", element: <CreateRoutine /> },
          { path: "templates", element: <RoutineTemplates /> },
        ],
      },
      {
        path: "focus",
        element: <Focus />,
        children: [
          { index: true, element: <Navigate to="timer" replace /> },
          { path: "timer", element: <FocusTimer /> },
          { path: "history", element: <FocusHistory /> },
        ],
      },
      {
        path: "cleanup",
        element: <Cleanup />,
        children: [
          { index: true, element: <Navigate to="downloads" replace /> },
          { path: "downloads", element: <CleanupDownloads /> },
          { path: "desktop", element: <CleanupDesktop /> },
          { path: "duplicates", element: <CleanupDuplicates /> },
          { path: "large-files", element: <CleanupLargeFiles /> },
          { path: "screenshots", element: <CleanupScreenshots /> },
          { path: "storage", element: <CleanupStorage /> },
        ],
      },
      {
        path: "progress",
        element: <Progress />,
        children: [
          { index: true, element: <Navigate to="statistics" replace /> },
          { path: "statistics", element: <ProgressStatistics /> },
          { path: "achievements", element: <ProgressAchievements /> },
          { path: "streak", element: <ProgressStreak /> },
        ],
      },
      { path: "settings", element: <Settings /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
];
