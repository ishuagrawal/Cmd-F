# Renderer boundary

Deferred intentionally. `ENABLE_RENDERER=true` fails closed at startup. A future isolated worker implements `renderPublicPage(validatedUrl, limits)` returning `rendered | blocked | login_required | timeout | policy_blocked`, with anonymous contexts, process resource limits and an egress firewall. Browser request interception alone is insufficient. No renderer or user-profile automation is shipped.
