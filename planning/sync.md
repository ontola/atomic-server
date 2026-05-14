We've recently implemented WS sync.
It works pretty well on Browser + Server + OPFS interaction, and we also use it to sync 2 flutter instances in the canvas app.
But there are a bunch of shortcomings:

## Handshake and context

- We can pair with QR code, and the QR code transfers some information about the name of the device. But this only gives ONE of the devices information about the other device - only the QR scanner knows the name of the other
- The UX is odd. What if user A scans a QR of user B? That does not necessarily mean user B agrees that A should access this. I think this means we need to initialize a share request.

## Bugs

- After signing in with the same secret on 2 devices, and using QR to set up sync, the resources sync successfully initially. Awesome. But after htat initial sync, i don't see new strokes appears. When i create a new resource, i do see a new (empty) item appearing, but not the strokes. Even after manual retry / refresh. I suppose we lack a test for this case.
