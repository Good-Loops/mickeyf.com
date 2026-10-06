/**
 * Generic dropdown/select UI primitive.
 * Depends on React state and a document click listener to close on outside interaction.
 * Cleanup must remove the document listener on unmount.
 */
import React, { ReactNode, useEffect, useId, useRef, useState } from 'react';

type DropdownOption = { value: string; label: string };

interface DropdownProps {
    options: DropdownOption[];
    value: string | null;
    onChange: (value: string) => void;
    disabled?: boolean;
    placeholder?: string;
    className?: string;
    buttonClassName?: string;
    selectedClassName?: string;
    caretClassName?: string;
    menuClassName?: string;
    optionClassName?: string;
    /** Optional custom renderer for the selected label. */
    renderSelected?: (selected: DropdownOption | null, label: string) => ReactNode;
}
const Dropdown: React.FC<DropdownProps> = ({
    options,
    value,
    onChange,
    disabled = false,
    placeholder = 'Select…',
    className = '',
    buttonClassName = '',
    selectedClassName = '',
    caretClassName = '',
    menuClassName = '',
    optionClassName = '',
    renderSelected,
}) => {
    const [open, setOpen] = useState(false);
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const menuId = useId();
    const isOpen = open && !disabled;

    useEffect(() => {
        if (disabled) {
            setOpen(false);
            return;
        }
        if (!open) return;

        const handleDocClick = (e: MouseEvent) => {
            if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };

        // Must unregister on unmount to prevent leaked listeners.
        document.addEventListener('click', handleDocClick);
        return () => document.removeEventListener('click', handleDocClick);
    }, [open, disabled]);

    const closeAndFocusButton = () => {
        setOpen(false);
        buttonRef.current?.focus();
    };

    const handleToggle = () => {
        if (disabled) return;
        setOpen((prev) => !prev);
    };

    const handleSelect = (val: string) => {
        if (!isOpen) return;
        onChange(val);
        closeAndFocusButton();
    };

    const selectedOption = options.find((o) => o.value === value) ?? null;
    const label = selectedOption ? selectedOption.label : placeholder;

    return (
        <div
            className={`dropdown ${isOpen ? 'dropdown--open active' : ''} ${className}`.trim()}
            ref={wrapperRef}
            onBlur={(event) => {
                // Some browsers report null before an option click; let click dismissal handle it.
                if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
            }}
            onKeyDown={(event) => {
                if (event.key !== 'Escape' || !isOpen) return;
                event.preventDefault();
                event.stopPropagation();
                closeAndFocusButton();
            }}
        >
            <button
                type="button"
                ref={buttonRef}
                className={`dropdown__button ${buttonClassName}`.trim()}
                disabled={disabled}
                aria-controls={menuId}
                aria-expanded={isOpen}
                onClick={handleToggle}
            >
                <span className={`dropdown__selected ${selectedClassName}`.trim()}>
                    {renderSelected ? renderSelected(selectedOption, label) : label}
                </span>
                <span className={`dropdown__caret ${caretClassName}`.trim()}>▾</span>
            </button>

            <ul
                id={menuId}
                className={`dropdown__menu ${menuClassName}`.trim()}
                // Keep the fade animation without leaving invisible options focusable.
                inert={!isOpen}
            >
                {options.map((opt) => (
                    <li key={opt.value}>
                        <button
                            type="button"
                            className={`dropdown__option ${optionClassName}`.trim()}
                            onClick={() => handleSelect(opt.value)}
                        >
                            {opt.label}
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
};

export default Dropdown;
