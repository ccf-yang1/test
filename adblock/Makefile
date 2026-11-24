ARCHS = arm64 arm64e
TARGET = iphone:clang:latest:14.0
INSTALL_TARGET_PROCESSES = SpringBoard

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = AdBlockConfig
AdBlockConfig_FILES = test.x
AdBlockConfig_FRAMEWORKS = UIKit Foundation WebKit CoreGraphics
AdBlockConfig_CFLAGS = -fobjc-arc

include $(THEOS_MAKE_PATH)/tweak.mk

.PHONY: dylib
dylib:
	bash ./build-dylib.sh
