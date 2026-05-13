.PHONY: web tablet phone emu reload-web restart-web reload-tablet restart-tablet reload-phone restart-phone reload-emu restart-emu reload-all restart-all analyze

web:
	./dev.sh web

tablet:
	./dev.sh tablet

phone:
	./dev.sh phone

emu:
	./dev.sh emu

reload-web:
	@echo r > /tmp/atomiccanvas_web_pipe

restart-web:
	@echo R > /tmp/atomiccanvas_web_pipe

reload-tablet:
	@echo r > /tmp/atomiccanvas_tablet_pipe

restart-tablet:
	@echo R > /tmp/atomiccanvas_tablet_pipe

reload-phone:
	@echo r > /tmp/atomiccanvas_phone_pipe

restart-phone:
	@echo R > /tmp/atomiccanvas_phone_pipe

reload-emu:
	@echo r > /tmp/atomiccanvas_emu_pipe

restart-emu:
	@echo R > /tmp/atomiccanvas_emu_pipe

reload-all:
	@echo r > /tmp/atomiccanvas_web_pipe 2>/dev/null; echo r > /tmp/atomiccanvas_tablet_pipe 2>/dev/null; echo r > /tmp/atomiccanvas_phone_pipe 2>/dev/null; echo r > /tmp/atomiccanvas_emu_pipe 2>/dev/null

restart-all:
	@echo R > /tmp/atomiccanvas_web_pipe 2>/dev/null; echo R > /tmp/atomiccanvas_tablet_pipe 2>/dev/null; echo R > /tmp/atomiccanvas_phone_pipe 2>/dev/null; echo R > /tmp/atomiccanvas_emu_pipe 2>/dev/null

analyze:
	@~/.local/share/mise/installs/flutter/3.22.1-stable/bin/flutter analyze lib/
