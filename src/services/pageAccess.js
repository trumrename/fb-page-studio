/**
 * Full page people access: personal roles + BM assigned users.
 * Classifies Admin vs Editor from Graph "tasks".
 */
import {
  graphGetSoft,
  getMyBusinesses,
  sleep,
} from "./facebook.js";

/** Paginate a Graph edge until no next (soft errors stop). */
export async function graphGetAllSoft(path, token, query = {}, { maxPages = 50 } = {}) {
  const all = [];
  let after = null;
  let lastError = null;
  for (let i = 0; i < maxPages; i++) {
    const q = { ...query, limit: query.limit || 100 };
    if (after) q.after = after;
    const r = await graphGetSoft(path, token, q);
    if (!r.ok) {
      lastError = r.error;
      break;
    }
    const batch = r.data?.data || [];
    all.push(...batch);
    const next = r.data?.paging?.cursors?.after;
    if (!r.data?.paging?.next || !next || batch.length === 0) break;
    after = next;
  }
  return { ok: !lastError || all.length > 0, data: all, error: lastError };
}

/**
 * Map Meta page tasks → human role.
 * Admin (MANAGE): add people, delete page, full control.
 * Editor (CREATE_CONTENT without MANAGE): content only, no add-people / delete page.
 */
export function classifyPageTasks(tasks) {
  const t = new Set(
    (tasks || []).map((x) => String(x).toUpperCase().replace(/\s+/g, "_"))
  );
  const has = (...keys) => keys.some((k) => t.has(k));

  if (
    has(
      "MANAGE",
      "PROFILE_PLUS_FULL_CONTROL",
      "PROFILE_PLUS_MANAGE",
      "PROFILE_PLUS_FACEBOOK_ACCESS"
    )
  ) {
    return {
      role_key: "admin",
      role_label: "Admin",
      can_add_people: true,
      can_delete_page: true,
      can_manage_roles: true,
      note: "Full control — thêm người, xóa page (tương đương quyền MANAGE)",
    };
  }
  if (has("CREATE_CONTENT", "PROFILE_PLUS_CREATE_CONTENT")) {
    return {
      role_key: "editor",
      role_label: "Biên tập viên (Editor)",
      can_add_people: false,
      can_delete_page: false,
      can_manage_roles: false,
      note: "Tạo/sửa nội dung — không thêm admin, không xóa page",
    };
  }
  if (has("MODERATE", "PROFILE_PLUS_MODERATE", "MODERATE_COMMUNITY")) {
    return {
      role_key: "moderator",
      role_label: "Kiểm duyệt (Moderator)",
      can_add_people: false,
      can_delete_page: false,
      can_manage_roles: false,
      note: "Kiểm duyệt bình luận/cộng đồng",
    };
  }
  if (has("ADVERTISE", "PROFILE_PLUS_ADVERTISE")) {
    return {
      role_key: "advertiser",
      role_label: "Nhà quảng cáo",
      can_add_people: false,
      can_delete_page: false,
      can_manage_roles: false,
      note: "Chạy ads / phân tích quảng cáo",
    };
  }
  if (has("ANALYZE", "PROFILE_PLUS_ANALYZE", "VIEW_MONETIZATION_INSIGHTS")) {
    return {
      role_key: "analyst",
      role_label: "Nhà phân tích",
      can_add_people: false,
      can_delete_page: false,
      can_manage_roles: false,
      note: "Chỉ xem insights",
    };
  }
  if (has("MESSAGING", "PROFILE_PLUS_MESSAGING")) {
    return {
      role_key: "messaging",
      role_label: "Tin nhắn",
      can_add_people: false,
      can_delete_page: false,
      can_manage_roles: false,
      note: "Quản lý tin nhắn page",
    };
  }
  return {
    role_key: "other",
    role_label: "Khác",
    can_add_people: false,
    can_delete_page: false,
    can_manage_roles: false,
    note: tasks?.length ? `Tasks: ${tasks.join(", ")}` : "Không rõ task",
  };
}

function normalizePerson(u, source) {
  const tasks = u.tasks || u.permitted_tasks || [];
  const cls = classifyPageTasks(tasks);
  return {
    id: u.id,
    name: u.name || null,
    email: u.email || null,
    is_active: u.is_active !== false,
    user_type: u.user_type || null,
    tasks: [...new Set(tasks)],
    source,
    ...cls,
  };
}

/** In-memory BM index cache (per process) — huge API saver */
const businessCtxCache = new Map(); // userTokenHash -> { at, data }
const BM_CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours

function tokenKey(userToken) {
  // short stable key without storing full token in logs
  return String(userToken || "").slice(-24);
}

/**
 * Build map: page_id → { business_id, business_name }
 * + BM admins only for businesses that own at least one page (saves calls).
 * Cached 6h per user token.
 */
export async function buildBusinessContext(userToken, { force = false } = {}) {
  const key = tokenKey(userToken);
  const hit = businessCtxCache.get(key);
  if (!force && hit && Date.now() - hit.at < BM_CACHE_MS) {
    return hit.data;
  }

  const pageToBusiness = new Map();
  const businessMeta = new Map();

  const bizRes = await getMyBusinesses(userToken);
  if (!bizRes.ok) {
    const data = {
      pageToBusiness,
      businessMeta,
      businesses_error: bizRes.error,
      businesses: [],
      from_cache: false,
    };
    return data;
  }

  const businesses = bizRes.data?.data || [];
  const businessesWithPages = [];

  for (const b of businesses) {
    let pageCount = 0;
    for (const edge of ["owned_pages", "client_pages"]) {
      const pages = await graphGetAllSoft(`/${b.id}/${edge}`, userToken, {
        fields: "id,name",
        limit: 100,
      });
      if (!pages.ok) continue;
      for (const p of pages.data) {
        if (!p.id) continue;
        pageCount++;
        if (!pageToBusiness.has(p.id) || edge === "owned_pages") {
          pageToBusiness.set(p.id, {
            business_id: b.id,
            business_name: b.name || null,
            relation: edge === "owned_pages" ? "owned" : "client",
          });
        }
      }
      await sleep(40);
    }
    if (pageCount > 0) businessesWithPages.push(b);
    await sleep(40);
  }

  // Only fetch BM admins for businesses that actually own pages
  for (const b of businessesWithPages) {
    const users = await graphGetAllSoft(`/${b.id}/business_users`, userToken, {
      fields: "id,name,role,title,email",
      limit: 100,
    });
    const admins = [];
    if (users.ok) {
      for (const u of users.data) {
        const role = String(u.role || "").toUpperCase();
        if (role === "ADMIN" || role === "ADMINISTRATOR") {
          admins.push({
            id: u.id,
            name: u.name || null,
            email: u.email || null,
            role: u.role || "ADMIN",
            title: u.title || null,
            source: "business_users",
          });
        }
      }
    }
    businessMeta.set(b.id, {
      id: b.id,
      name: b.name || null,
      admins,
      users_error: users.error || null,
    });
    await sleep(40);
  }

  // Empty meta for BMs with no pages
  for (const b of businesses) {
    if (!businessMeta.has(b.id)) {
      businessMeta.set(b.id, {
        id: b.id,
        name: b.name || null,
        admins: [],
        users_error: null,
      });
    }
  }

  const data = {
    pageToBusiness,
    businessMeta,
    businesses_error: null,
    businesses: businesses.map((b) => ({ id: b.id, name: b.name })),
    from_cache: false,
  };
  businessCtxCache.set(key, { at: Date.now(), data: { ...data, from_cache: true } });
  return data;
}

/**
 * Full people access for one page.
 * @param {string} pageId
 * @param {string} pageToken
 * @param {object} [ctx] from buildBusinessContext
 * @param {string} [userToken] optional — for business discovery
 */
export async function fetchPageAccessFull(pageId, pageToken, ctx = null, userToken = null) {
  const errors = [];
  const peopleById = new Map();

  // 1) Personal / non-BM roles (paginated)
  const roles = await graphGetAllSoft(`/${pageId}/roles`, pageToken, {
    fields: "id,name,tasks,is_active",
    limit: 100,
  });
  if (roles.ok) {
    for (const u of roles.data) {
      const person = normalizePerson(u, "roles");
      peopleById.set(person.id, person);
    }
  } else {
    errors.push(`roles: ${roles.error}`);
  }

  // 2) Resolve business for this page (index first)
  let business = null;
  if (ctx?.pageToBusiness?.has(pageId)) {
    const m = ctx.pageToBusiness.get(pageId);
    business = {
      id: m.business_id,
      name: m.business_name,
      relation: m.relation,
    };
  } else {
    const soft = await graphGetSoft(`/${pageId}`, pageToken, {
      fields: "business{id,name}",
    });
    if (soft.ok && soft.data?.business?.id) {
      business = {
        id: soft.data.business.id,
        name: soft.data.business.name || null,
        relation: "linked",
      };
    } else if (userToken && !ctx) {
      const built = await buildBusinessContext(userToken);
      ctx = built;
      if (built.pageToBusiness.has(pageId)) {
        const m = built.pageToBusiness.get(pageId);
        business = {
          id: m.business_id,
          name: m.business_name,
          relation: m.relation,
        };
      }
    }
  }

  // 3) assigned_users — try ALL businesses user can access
  // (ownership index can miss pages; still must pass business=)
  let assigned_error = null;
  const businessIdsToTry = [];
  if (business?.id) businessIdsToTry.push({
    id: business.id,
    name: business.name,
  });
  if (ctx?.businesses?.length) {
    for (const b of ctx.businesses) {
      if (!businessIdsToTry.some((x) => x.id === b.id)) {
        businessIdsToTry.push({ id: b.id, name: b.name });
      }
    }
  }

  let assignedHits = 0;
  if (businessIdsToTry.length) {
    for (const b of businessIdsToTry) {
      const assigned = await graphGetAllSoft(
        `/${pageId}/assigned_users`,
        pageToken,
        {
          business: b.id,
          fields: "id,name,tasks,user_type",
          limit: 100,
        }
      );
      if (assigned.ok && assigned.data.length) {
        assignedHits += assigned.data.length;
        if (!business) {
          business = {
            id: b.id,
            name: b.name || null,
            relation: "assigned_users_hit",
          };
        }
        for (const u of assigned.data) {
          const person = normalizePerson(u, "assigned_users");
          person.business_id = b.id;
          person.business_name = b.name || null;
          const prev = peopleById.get(person.id);
          if (prev) {
            const tasks = [
              ...new Set([...(prev.tasks || []), ...person.tasks]),
            ];
            const merged = normalizePerson(
              { ...person, tasks },
              "roles+assigned"
            );
            merged.business_id = b.id;
            merged.business_name = b.name || null;
            peopleById.set(person.id, merged);
          } else {
            peopleById.set(person.id, person);
          }
        }
      } else if (!assigned.ok && assigned.error) {
        assigned_error = assigned.error;
      }
    }
    if (!assignedHits && !business) {
      assigned_error =
        "Không tìm thấy user gán qua BM (page có thể chỉ có role cá nhân)";
    }
  } else {
    assigned_error =
      "Không có BM / thiếu business_management — chỉ quét được /roles";
  }

  // Agencies skipped by default (extra API cost; enable later if needed)
  const agency_list = [];

  const page_people = [...peopleById.values()].sort((a, b) => {
    const order = { admin: 0, editor: 1, moderator: 2, advertiser: 3, analyst: 4 };
    return (order[a.role_key] ?? 9) - (order[b.role_key] ?? 9);
  });

  const summary = {
    total: page_people.length,
    admins: page_people.filter((p) => p.role_key === "admin").length,
    editors: page_people.filter((p) => p.role_key === "editor").length,
    moderators: page_people.filter((p) => p.role_key === "moderator").length,
    others: page_people.filter(
      (p) => !["admin", "editor", "moderator"].includes(p.role_key)
    ).length,
  };

  let business_admins = [];
  if (business?.id && ctx?.businessMeta?.has(business.id)) {
    business_admins = ctx.businessMeta.get(business.id).admins || [];
    if (!business.name) {
      business.name = ctx.businessMeta.get(business.id).name || null;
    }
  }

  return {
    page_people,
    summary,
    business,
    business_admins,
    agencies: agency_list,
    errors,
    assigned_error,
    // transparency: what Graph actually returned
    graph_meta: {
      roles_count: roles.ok ? roles.data.length : 0,
      roles_error: roles.error || null,
      assigned_hits: assignedHits,
      businesses_tried: businessIdsToTry.map((b) => b.id),
      note:
        "Danh sách chỉ gồm người Meta Graph trả về qua /roles và /assigned_users. " +
        "Pending invite, partner, ads-only, hoặc Facebook access chỉ hiện trên UI có thể không có trong API.",
    },
    // back-compat for old UI fields
    roles: page_people.filter((p) => p.source === "roles" || p.source === "roles+assigned"),
    assigned_users: page_people.filter((p) => p.source === "assigned_users"),
  };
}

export function accessLabel(access) {
  if (!access?.summary) return "—";
  const s = access.summary;
  const parts = [];
  if (s.admins) parts.push(`${s.admins} Admin`);
  if (s.editors) parts.push(`${s.editors} Editor`);
  if (s.moderators) parts.push(`${s.moderators} Mod`);
  if (s.others) parts.push(`${s.others} khác`);
  if (!parts.length) return s.total ? `${s.total} người` : "—";
  return parts.join(" · ");
}
