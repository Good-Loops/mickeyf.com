import assert from 'node:assert/strict';
import test from 'node:test';
import { bindP4Input } from './p4Input.ts';

const eventTarget = () => {
    const listeners = new Map();
    return {
        listeners,
        addEventListener(name, handler) { listeners.set(name, handler); },
        removeEventListener(name, handler) {
            assert.equal(listeners.get(name), handler);
            listeners.delete(name);
        },
        emit(name, overrides = {}) {
            const event = {
                defaultPrevented: false, repeat: false, target: null,
                pointerId: 1, isPrimary: true, button: 0, clientX: 85, clientY: 50,
                preventDefault() { this.defaultPrevented = true; },
                ...overrides,
            };
            listeners.get(name)?.(event);
            return event;
        },
    };
};

const fixture = () => {
    const keyboard = eventTarget();
    keyboard.hidden = false;
    const focus = eventTarget();
    const thumb = { style: { transform: '' } };
    const captures = new Set();
    const joystick = {
        ...eventTarget(),
        querySelector: () => thumb,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
        setPointerCapture: (pointer) => captures.add(pointer),
        hasPointerCapture: (pointer) => captures.has(pointer),
        releasePointerCapture: (pointer) => captures.delete(pointer),
    };
    const movement = {
        isMovingRight: false, isMovingLeft: false, isMovingUp: false, isMovingDown: false,
        joystickX: 0, joystickY: 0,
    };
    let running = true;
    let restartReady = false;
    let restarts = 0;
    const input = bindP4Input({
        keyboardTarget: keyboard, focusTarget: focus, joysticks: [joystick], movement: () => movement,
        canMove: () => running, canRestart: () => restartReady,
        restart: () => { restarts++; },
    });
    return {
        input, keyboard, focus, joystick, movement, captures, thumb,
        setRunning: (value) => { running = value; },
        setRestartReady: (value) => { restartReady = value; },
        get restarts() { return restarts; },
    };
};

test('clearing held arrows and ignoring repeats prevents stuck movement across pause', () => {
    const f = fixture();
    f.keyboard.emit('keydown', { code: 'ArrowRight' });
    assert.equal(f.movement.isMovingRight, true);
    f.setRunning(false);
    f.input.clear();
    f.keyboard.emit('keydown', { code: 'ArrowLeft' });
    assert.equal(f.movement.isMovingLeft, false);
    f.setRunning(true);
    f.keyboard.emit('keydown', { code: 'ArrowRight', repeat: true });
    assert.equal(f.movement.isMovingRight, false);
    f.keyboard.emit('keyup', { code: 'ArrowRight' });
    f.keyboard.emit('keydown', { code: 'ArrowRight' });
    assert.equal(f.movement.isMovingRight, true);
    f.keyboard.emit('keyup', { code: 'ArrowRight' });
    assert.equal(f.movement.isMovingRight, false);
});

test('Space activates page buttons normally and restarts only a finished game-over', () => {
    const f = fixture();
    f.keyboard.emit('keydown', { code: 'Space' });
    assert.equal(f.restarts, 0);
    f.setRunning(false);
    f.setRestartReady(true);
    const button = { closest: (selector) => selector.includes('button') ? {} : null };
    const press = f.keyboard.emit('keydown', { code: 'Space', target: button });
    assert.equal(press.defaultPrevented, false);
    assert.equal(f.restarts, 0);
    f.keyboard.emit('keydown', { code: 'Space', repeat: true });
    assert.equal(f.restarts, 0);
    f.keyboard.emit('keydown', { code: 'Space' });
    assert.equal(f.restarts, 1);
});

test('editable fields retain arrows and Space; focused game buttons retain movement arrows', () => {
    const f = fixture();
    const input = { closest: (selector) => selector.includes('input') ? {} : null };
    const press = f.keyboard.emit('keydown', { code: 'ArrowRight', target: input });
    assert.equal(press.defaultPrevented, false);
    assert.equal(f.movement.isMovingRight, false);
    const button = { closest: (selector) => selector.includes('button') ? {} : null };
    f.keyboard.emit('keydown', { code: 'ArrowRight', target: button });
    assert.equal(f.movement.isMovingRight, true);
});

test('pause releases joystick capture, centers its thumb and ignores the old pointer after resume', () => {
    const f = fixture();
    f.joystick.emit('pointerdown');
    assert.equal(f.movement.joystickX, 1);
    assert.equal(f.captures.has(1), true);
    f.setRunning(false);
    f.input.clear();
    assert.equal(f.captures.size, 0);
    assert.equal(f.thumb.style.transform, 'translate(0, 0)');
    assert.equal(f.movement.isMovingRight, false);
    assert.equal(f.movement.joystickX, 0);
    assert.equal(f.movement.joystickY, 0);
    f.joystick.emit('pointerdown', { pointerId: 2 });
    assert.equal(f.captures.size, 0);
    f.setRunning(true);
    f.joystick.emit('pointermove');
    assert.equal(f.movement.joystickX, 0);
    f.joystick.emit('pointerdown', { pointerId: 3 });
    assert.equal(f.movement.joystickX, 1);
});

test('pointer cancellation and disposal remove input ownership', () => {
    const f = fixture();
    f.joystick.emit('pointerdown');
    f.joystick.emit('pointercancel');
    assert.equal(f.movement.isMovingRight, false);
    assert.equal(f.movement.joystickX, 0);
    assert.equal(f.movement.joystickY, 0);
    assert.equal(f.captures.size, 0);
    f.joystick.emit('pointerdown', { pointerId: 2 });
    f.input.dispose();
    assert.equal(f.captures.size, 0);
    assert.equal(f.keyboard.listeners.size, 0);
    assert.equal(f.focus.listeners.size, 0);
    assert.equal(f.joystick.listeners.size, 0);
    assert.equal(f.movement.joystickX, 0);
    assert.equal(f.movement.joystickY, 0);
});

test('joystick uses a radial deadzone and proportional speed up to full tilt', () => {
    const f = fixture();
    f.joystick.emit('pointerdown', { clientX: 50, clientY: 50 });
    assert.equal(f.movement.joystickX, 0);
    assert.equal(f.movement.joystickY, 0);
    f.joystick.emit('pointermove', { clientX: 55, clientY: 50 });
    assert.equal(f.movement.joystickX, 0);
    f.joystick.emit('pointermove', { clientX: 66, clientY: 50 });
    assert.ok(Math.abs(f.movement.joystickX - (.5 - .18) / .82) < 1e-12);
    assert.equal(f.movement.joystickY, 0);
    f.joystick.emit('pointermove', { clientX: 82, clientY: 50 });
    assert.equal(f.movement.joystickX, 1);
    f.joystick.emit('pointermove', { clientX: 150, clientY: 50 });
    assert.equal(f.movement.joystickX, 1);
    assert.equal(f.thumb.style.transform, 'translate(32px, 0px)');
});

test('full diagonal tilt keeps both axes at full speed while the thumb stays circular', () => {
    const f = fixture();
    f.joystick.emit('pointerdown', { clientX: 100, clientY: 100 });
    assert.equal(f.movement.joystickX, 1);
    assert.equal(f.movement.joystickY, 1);
    const offsets = f.thumb.style.transform.match(/translate\(([^p]+)px, ([^p]+)px\)/);
    assert.ok(Math.abs(Math.hypot(Number(offsets[1]), Number(offsets[2])) - 32) < 1e-12);
    f.joystick.emit('pointermove', { clientX: 0, clientY: 0 });
    assert.equal(f.movement.joystickX, -1);
    assert.equal(f.movement.joystickY, -1);
});

test('joystick release does not clear a held keyboard arrow, and keyup does not clear the stick', () => {
    const f = fixture();
    f.keyboard.emit('keydown', { code: 'ArrowLeft' });
    f.joystick.emit('pointerdown');
    assert.equal(f.movement.isMovingLeft, true);
    assert.equal(f.movement.isMovingRight, false);
    assert.equal(f.movement.joystickX, 1);
    f.joystick.emit('pointerup');
    assert.equal(f.movement.isMovingLeft, true);
    assert.equal(f.movement.joystickX, 0);
    f.joystick.emit('pointerdown', { pointerId: 2 });
    f.keyboard.emit('keyup', { code: 'ArrowLeft' });
    assert.equal(f.movement.isMovingLeft, false);
    assert.equal(f.movement.joystickX, 1);
    f.keyboard.emit('keydown', { code: 'ArrowUp' });
    f.input.clear();
    assert.equal(f.movement.isMovingUp, false);
    assert.equal(f.movement.joystickX, 0);
});

test('losing pointer capture clears the analog input and centers the thumb', () => {
    const f = fixture();
    f.joystick.emit('pointerdown');
    f.joystick.emit('lostpointercapture');
    assert.equal(f.movement.joystickX, 0);
    assert.equal(f.movement.joystickY, 0);
    assert.equal(f.thumb.style.transform, 'translate(0, 0)');
    assert.equal(f.captures.size, 0);
});

test('window blur and hiding the document release held keys and joystick capture', () => {
    for (const event of ['blur', 'visibilitychange']) {
        const f = fixture();
        f.keyboard.emit('keydown', { code: 'ArrowRight' });
        f.joystick.emit('pointerdown');
        if (event === 'blur') f.focus.emit(event);
        else {
            f.keyboard.hidden = true;
            f.keyboard.emit(event);
        }
        assert.equal(f.movement.isMovingRight, false, event);
        assert.equal(f.movement.joystickX, 0, event);
        assert.equal(f.captures.size, 0, event);
        assert.equal(f.thumb.style.transform, 'translate(0, 0)', event);
        f.keyboard.emit('keydown', { code: 'ArrowRight', repeat: true });
        assert.equal(f.movement.isMovingRight, false, 'a held key must be pressed again');
        f.input.dispose();
        assert.equal(f.focus.listeners.size, 0);
        assert.equal(f.keyboard.listeners.size, 0);
    }
});

test('a visible document event does not interrupt active input', () => {
    const f = fixture();
    f.keyboard.emit('keydown', { code: 'ArrowRight' });
    f.keyboard.emit('visibilitychange');
    assert.equal(f.movement.isMovingRight, true);
    f.input.dispose();
});
