from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

PINNED = "89ff58ca86b2104ac6c55ae8a5dc77e4ab3e8d00"


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"{path}: expected exactly one patch anchor, found {n}: {old[:100]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="Apply ASTRA precision scoring to pinned TraceMaker placement ECO.")
    ap.add_argument("tracemaker_root", type=Path)
    ap.add_argument("--allow-dirty", action="store_true")
    args = ap.parse_args()
    root = args.tracemaker_root.resolve()

    head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if head != PINNED:
        raise SystemExit(f"TraceMaker HEAD {head} != pinned {PINNED}")
    if not args.allow_dirty:
        dirty = subprocess.check_output(["git", "-C", str(root), "status", "--porcelain"], text=True)
        if dirty.strip():
            raise SystemExit("TraceMaker tree is dirty; use a clean clone or --allow-dirty")

    hpp = root / "src/place/routable.hpp"
    cpp = root / "src/place/routable.cpp"
    main_cpp = root / "src/place/place_main.cpp"

    replace_once(
        hpp,
        """  bool ok = false;
  int connections = 0, routed = 0;
  int unrouted() const { return connections - routed; }
""",
        """  bool ok = false;
  int connections = 0, routed = 0;
  // Optional placement-quality fields. They stay zero when the caller does not
  // provide a priority profile, preserving upstream behaviour exactly.
  bool precision = false;         // caller supplied a placement priority profile
  int critical_dead = 0;          // signal pins that cannot escape on critical nets
  int critical_boxed = 0;         // critical unresolved connections reported boxed-in by the router
  int dead_signal = 0;            // signal pins that cannot escape (plane/zone nets excluded by caller)
  int boxed_signal = 0;           // non-plane unresolved connections reported boxed-in
  std::int64_t critical_penalty = 0;  // weighted unresolved critical connections
  std::int64_t weighted_penalty = 0;  // weighted unresolved connections
  int unrouted() const { return connections - routed; }
""",
    )
    replace_once(
        hpp,
        """using RouteFn = std::function<RouteEval(const Placement&)>;

struct Candidate {
""",
        """using RouteFn = std::function<RouteEval(const Placement&)>;

// Lexicographic route quality used by ECO/routability-loop acceptance.
// With all optional fields at zero this reduces to upstream's raw unrouted count.
bool better_eval(const RouteEval& a, const RouteEval& b);

struct Candidate {
""",
    )

    replace_once(
        cpp,
        """bool better(const Candidate& a, const Candidate& b) {
  if (a.eval.ok != b.eval.ok) return a.eval.ok;
  if (a.eval.unrouted() != b.eval.unrouted()) return a.eval.unrouted() < b.eval.unrouted();
  return a.hpwl < b.hpwl;
}
""",
        """bool better_eval(const RouteEval& a, const RouteEval& b) {
  if (a.ok != b.ok) return a.ok;
  if (!a.ok) return false;
  if (a.critical_dead != b.critical_dead) return a.critical_dead < b.critical_dead;
  if (a.critical_boxed != b.critical_boxed) return a.critical_boxed < b.critical_boxed;
  if (a.critical_penalty != b.critical_penalty) return a.critical_penalty < b.critical_penalty;
  if (a.unrouted() != b.unrouted()) return a.unrouted() < b.unrouted();
  if (a.boxed_signal != b.boxed_signal) return a.boxed_signal < b.boxed_signal;
  if (a.dead_signal != b.dead_signal) return a.dead_signal < b.dead_signal;
  if (a.weighted_penalty != b.weighted_penalty) return a.weighted_penalty < b.weighted_penalty;
  return false;
}

bool better(const Candidate& a, const Candidate& b) {
  if (better_eval(a.eval, b.eval)) return true;
  if (better_eval(b.eval, a.eval)) return false;
  return a.hpwl < b.hpwl;
}
""",
    )
    replace_once(
        cpp,
        """      if (e.unrouted() < res.eval.unrouted() && (best < 0 || e.unrouted() < best_eval.unrouted())) {
""",
        """      if (better_eval(e, res.eval) && (best < 0 || better_eval(e, best_eval))) {
""",
    )
    replace_once(
        cpp,
        """      if (c.eval.ok && c.eval.unrouted() < inc.eval.unrouted()) {
""",
        """      if (better_eval(c.eval, inc.eval)) {
""",
    )

    replace_once(
        cpp,
        """      // Swap with an interchangeable part (same footprint, side and orientation class).
      for (std::size_t bi = 0; bi < p.parts.size(); ++bi) {
""",
        """      // Same-footprint is not enough to prove electrical interchangeability. ASTRA precision mode
      // keeps local shift/rotate moves but forbids cross-functional swaps (e.g. Hall vs current-sense 0402).
      if (res.eval.precision) continue;
      // Swap with an interchangeable part (same footprint, side and orientation class).
      for (std::size_t bi = 0; bi < p.parts.size(); ++bi) {
""",
    )

    replace_once(main_cpp, "#include <map>\n", "#include <map>\n#include <set>\n")
    replace_once(
        main_cpp,
        '#include "route/router.hpp"\n',
        '#include "route/router.hpp"\n#include "route/escape.hpp"\n#include "route/obstacles.hpp"\n',
    )

    marker = """// The router as a placement evaluator: the input document with the placement applied, routed in memory with a
// deterministic work budget; unrouted connections are mapped back to parts and pad positions.
"""
    priority_code = r'''struct RoutePriority {
  bool enabled = false;
  int critical_priority = 80;
  int default_priority = 20;
  std::int64_t default_weight = 100;
  std::map<std::string, std::pair<int, std::int64_t>> nets;  // name -> (priority, integer weight)
  std::set<std::string> escape_plane_nets;

  std::pair<int, std::int64_t> get(const std::string& name) const {
    const auto it = nets.find(name);
    return it == nets.end() ? std::pair{default_priority, default_weight} : it->second;
  }
};

RoutePriority load_route_priority(const std::string& path) {
  RoutePriority p;
  if (path.empty()) return p;
  std::ifstream f(path);
  if (!f) throw std::runtime_error("cannot open route priority file: " + path);
  const auto j = nlohmann::json::parse(f);
  p.enabled = true;
  p.critical_priority = j.value("critical_priority", 80);
  p.default_priority = j.value("default_priority", 20);
  p.default_weight = j.value("default_weight", 100);
  for (const auto& n : j.value("escape_plane_nets", nlohmann::json::array()))
    p.escape_plane_nets.insert(n.get<std::string>());
  if (const auto it = j.find("nets"); it != j.end() && it->is_object())
    for (auto ni = it->begin(); ni != it->end(); ++ni) {
      const auto& x = ni.value();
      p.nets.emplace(ni.key(), std::pair{x.value("priority", p.default_priority),
                                          static_cast<std::int64_t>(x.value("weight", static_cast<long long>(p.default_weight)))});
    }
  return p;
}

'''
    replace_once(main_cpp, marker, priority_code + marker)

    replace_once(
        main_cpp,
        """place::RouteFn make_route_fn(const std::string& in, const model::DesignRules& rules, const place::Problem& p, long work, int threads,
                             std::uint64_t seed) {
""",
        """place::RouteFn make_route_fn(const std::string& in, const model::DesignRules& rules, const place::Problem& p, long work, int threads,
                             std::uint64_t seed, const RoutePriority& priority) {
""",
    )

    replace_once(
        main_cpp,
        """    place::RouteEval e;
    io::LoadedBoard lb = io::read_board_file(in);
""",
        """    place::RouteEval e;
    e.precision = priority.enabled;
    io::LoadedBoard lb = io::read_board_file(in);
""",
    )

    replace_once(
        main_cpp,
        """    const model::Board b = io::read_board(lb.doc);  // applies the pending edits (same board as the saved file)
    route::RouterOptions ro;
""",
        """    model::Board b = io::read_board(lb.doc);  // mutable: Obstacles builds spatial state against the board

    // Static pin-escape feasibility is cheap compared with a route and catches the failure mode that
    // dominates dense ASTRA placements. Plane/zone nets are explicitly exempted by the profile.
    if (priority.enabled) {
      route::Obstacles obs(b, rules);
      const auto esc = route::analyse_escapes(b, rules, obs);
      for (const auto& pe : esc)
        for (const auto& dp : pe.dead) {
          if (dp.pad < 0 || static_cast<std::size_t>(dp.pad) >= b.pads.size()) continue;
          const model::NetId ni = b.pads[static_cast<std::size_t>(dp.pad)].net;
          if (ni <= 0 || static_cast<std::size_t>(ni) >= b.nets.size()) continue;
          const std::string& name = b.nets[static_cast<std::size_t>(ni)].name;
          if (priority.escape_plane_nets.contains(name)) continue;
          ++e.dead_signal;
          const auto [prio, weight] = priority.get(name);
          (void)weight;
          if (prio >= priority.critical_priority) ++e.critical_dead;
        }
    }

    route::RouterOptions ro;
""",
    )

    replace_once(
        main_cpp,
        """    ro.optimize = false;    // clean-up never changes the routed count, which is all the check reads
    const auto res = route::route_portfolio(b, rules, ro, threads).best;
""",
        """    ro.optimize = false;    // clean-up never changes the routed count, which is all the check reads
    if (priority.enabled) ro.escape_plan = true;  // same oracle as the final ASTRA --escape-plan route
    const auto res = route::route_portfolio(b, rules, ro, threads).best;
""",
    )

    replace_once(
        main_cpp,
        """    e.seconds = res.seconds;
    std::map<std::string, int> part_of;
""",
        """    e.seconds = res.seconds;
    if (priority.enabled)
      for (std::size_t ui = 0; ui < res.unrouted.size(); ++ui) {
        const auto& u = res.unrouted[ui];
        const auto [prio, weight] = priority.get(u.net);
        e.weighted_penalty += weight;
        if (prio >= priority.critical_priority) e.critical_penalty += weight;
        const bool plane = priority.escape_plane_nets.contains(u.net);
        const bool boxed = ui < res.failures.size() && res.failures[ui].find("boxed in") != std::string::npos;
        if (boxed && !plane) {
          ++e.boxed_signal;
          if (prio >= priority.critical_priority) ++e.critical_boxed;
        }
      }
    std::map<std::string, int> part_of;
""",
    )

    replace_once(
        main_cpp,
        """struct LoopCli {
  std::string in, out, json_path;
""",
        """struct LoopCli {
  std::string in, out, json_path;
  std::string route_priority;
""",
    )

    replace_once(
        main_cpp,
        """nlohmann::json eval_json(const place::RouteEval& e) {
  return {{"connections", e.connections}, {"routed", e.routed}, {"unrouted", e.unrouted()}, {"seconds", e.seconds}};
}
""",
        """nlohmann::json eval_json(const place::RouteEval& e) {
  return {{"connections", e.connections}, {"routed", e.routed}, {"unrouted", e.unrouted()}, {"seconds", e.seconds},
          {"precision", e.precision}, {"critical_dead", e.critical_dead}, {"critical_boxed", e.critical_boxed},
          {"dead_signal", e.dead_signal}, {"boxed_signal", e.boxed_signal},
          {"critical_penalty", e.critical_penalty}, {"weighted_penalty", e.weighted_penalty}};
}
""",
    )

    replace_once(
        main_cpp,
        """  const auto rules = io::read_design_rules(c.in);
  place::ExtractOptions eo;
""",
        """  const auto rules = io::read_design_rules(c.in);
  const RoutePriority priority = load_route_priority(c.route_priority);
  place::ExtractOptions eo;
""",
    )

    replace_once(
        main_cpp,
        """  const place::RouteFn route = make_route_fn(c.in, rules, P, c.work, c.route_threads, c.o.seed);
""",
        """  const place::RouteFn route = make_route_fn(c.in, rules, P, c.work, c.route_threads, c.o.seed, priority);
""",
    )
    replace_once(
        main_cpp,
        """    const place::RouteFn route_full = make_route_fn(c.in, rules, P, fw, c.route_threads, c.o.seed);
""",
        """    const place::RouteFn route_full = make_route_fn(c.in, rules, P, fw, c.route_threads, c.o.seed, priority);
""",
    )
    replace_once(
        main_cpp,
        """    const bool keep = vb.ok && vi.ok && vb.unrouted() <= vi.unrouted();
""",
        """    const bool keep = vb.ok && vi.ok && !place::better_eval(vi, vb);
""",
    )

    replace_once(
        main_cpp,
        """  int route_threads = 8;
  app.add_option("--route-check", route_check,
""",
        """  int route_threads = 8;
  std::string route_priority;
  app.add_option("--route-check", route_check,
""",
    )
    replace_once(
        main_cpp,
        """  app.add_option("--route-threads", route_threads, "Router portfolio size for --route-check");
""",
        """  app.add_option("--route-threads", route_threads, "Router portfolio size for --route-check");
  app.add_option("--route-priority", route_priority,
                 "JSON net priorities for eco/routable acceptance; also penalises non-plane dead escape pins")
      ->check(CLI::ExistingFile);
""",
    )
    replace_once(
        main_cpp,
        """    lc.route_threads = route_threads;
    lc.no_fallback = no_fallback;
""",
        """    lc.route_threads = route_threads;
    lc.route_priority = route_priority;
    lc.no_fallback = no_fallback;
""",
    )

    # Make the human-readable ECO trace expose why a move wins.
    replace_once(
        cpp,
        """std::string describe(const RouteEval& e) {
  return std::to_string(e.unrouted()) + " unrouted (" + std::to_string(e.routed) + "/" + std::to_string(e.connections) + ")";
}
""",
        """std::string describe(const RouteEval& e) {
  std::string s = std::to_string(e.unrouted()) + " unrouted (" + std::to_string(e.routed) + "/" + std::to_string(e.connections) + ")";
  if (e.precision)
    s += ", crit-dead " + std::to_string(e.critical_dead) + ", crit-box " + std::to_string(e.critical_boxed) +
         ", crit-pen " + std::to_string(e.critical_penalty) + ", boxed " + std::to_string(e.boxed_signal) +
         ", dead " + std::to_string(e.dead_signal) + ", wpen " + std::to_string(e.weighted_penalty);
  return s;
}
""",
    )

    print("ASTRA_PRECISION_PATCH_APPLIED")
    print(f"TraceMaker={root}")
    print(f"base={PINNED}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
