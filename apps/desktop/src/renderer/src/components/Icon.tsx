import React from 'react';
import {
  House,
  Users,
  UserRound,
  Mountain,
  Brain,
  Settings2,
  MessageCircle,
  BookOpen,
  ChartNoAxesColumnIncreasing,
  History,
  UserRoundCheck,
  Plug,
  KeyRound,
  Cpu,
  Gauge,
  Layers,
  Waypoints,
  Wrench,
  Network,
  Coins,
  ShieldCheck,
  FileCheck2,
  ClipboardCheck,
  RefreshCw,
  Plus,
  Pencil,
  Archive,
  Ellipsis,
  Upload,
  Folder,
  Copy,
  X,
  ChevronRight,
  ChevronLeft,
  Check,
  CircleAlert,
  ArrowUp,
  PanelLeft,
  Link2,
  Minus,
  Square,
  Search,
  CircleHelp,
  Send,
  Menu,
} from 'lucide-react';

const icons = {
  Home: House,
  Users,
  User: UserRound,
  Mission: Mountain,
  Memory: Brain,
  Settings: Settings2,
  Chat: MessageCircle,
  Skill: BookOpen,
  Capability: ChartNoAxesColumnIncreasing,
  History,
  HumanBridge: UserRoundCheck,
  Provider: Plug,
  Credential: KeyRound,
  Model: Cpu,
  Benchmark: Gauge,
  Embedding: Layers,
  Jev: Waypoints,
  Tool: Wrench,
  Mcp: Network,
  Usage: Coins,
  Approval: ShieldCheck,
  Artifact: FileCheck2,
  Review: ClipboardCheck,
  Refresh: RefreshCw,
  Add: Plus,
  Edit: Pencil,
  Archive,
  More: Ellipsis,
  Upload,
  Folder,
  Copy,
  Close: X,
  ChevronRight,
  ChevronLeft,
  Check,
  Alert: CircleAlert,
  ArrowUp,
  Panel: PanelLeft,
  Link: Link2,
  Minimize: Minus,
  Maximize: Square,
  Restore: Copy,
  Search,
  Help: CircleHelp,
  Send,
  Menu,
};

/** One local, tree-shaken icon vocabulary throughout the desktop product. */
export function Icon({
  name,
  size = 18,
  className = '',
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const Glyph = icons[name as keyof typeof icons] ?? CircleHelp;
  return (
    <Glyph
      size={size <= 16 ? 16 : size <= 20 ? 20 : 24}
      strokeWidth={1.8}
      className={`ui-icon ${className}`}
      aria-hidden="true"
    />
  );
}
